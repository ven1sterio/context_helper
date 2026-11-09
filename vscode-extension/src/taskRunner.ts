import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { getTimeouts } from './timeouts';

export interface RunResult {
    success: boolean;
    command: string;
    output: string;
    durationMs: number;
    exitCode?: number | null;
    via?: 'terminal' | 'process' | 'none';
    /** true se o usuário cancelou (Parar / abort) antes do comando concluir. */
    aborted?: boolean;
}

interface StepResult {
    success: boolean;
    output: string;
    exitCode: number | null;
    aborted?: boolean;
}

const MAX_OUTPUT = 50_000;
const POLICY_BLOCK_RE = /running scripts is disabled|PSSecurityException|UnauthorizedAccess|execu[cç][aã]o de scripts foi desabilitada/i;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function cleanTerminalText(raw: string): string {
    const s = raw
        .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
        .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '')
        .replace(/\u001b[()][A-Z0-9]/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, (c) => (c === '\r' ? '\r' : ''));
    return s.split('\n').map(line => {
        const i = line.lastIndexOf('\r');
        return i >= 0 ? line.slice(i + 1) : line;
    }).join('\n');
}

function truncateHead(text: string): string {
    return text.length > MAX_OUTPUT ? '[...início truncado...]\n' + text.slice(-MAX_OUTPUT) : text;
}

/**
 * Encerra um processo e todos os seus filhos.
 *  - Windows: `taskkill /pid X /T /F`
 *  - Unix: o processo foi criado com `detached: true`, então `-pid` é o PGID.
 */
function killTree(child: ChildProcess): void {
    const pid = child.pid;
    if (!pid) {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        return;
    }
    if (process.platform === 'win32') {
        try {
            spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
        } catch {
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }
        return;
    }
    try { process.kill(-pid, 'SIGTERM'); } catch {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL'); } catch {
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }
    }, 2000).unref?.();
}

/**
 * Executa o "build/test" do projeto para o agente Full Code verificar se o código funciona.
 *
 * Detecção (Fase 1): além de `workspaceRoot/package.json`, procura `package.json`
 * em subpastas DIRETAS (ex.: `vscode-extension/` quando a raiz é um monorepo).
 * Nesse caso, prefixa o comando com `cd "<subpasta>" && ...`.
 */
export class TaskRunner implements vscode.Disposable {
    private terminal?: vscode.Terminal;
    private channel: vscode.OutputChannel;
    private closeSub: vscode.Disposable;
    private currentChild: ChildProcess | null = null;
    private abortRequested = false;

    constructor(private workspaceRoot: string) {
        this.channel = vscode.window.createOutputChannel('DeepSeek Agent');
        this.closeSub = vscode.window.onDidCloseTerminal(t => {
            if (t === this.terminal) this.terminal = undefined;
        });
    }

    dispose() {
        this.closeSub.dispose();
        this.channel.dispose();
        this.terminal?.dispose();
    }

    cancel(): void {
        this.abortRequested = true;
        if (this.currentChild) killTree(this.currentChild);
        if (this.terminal) {
            try { this.terminal.sendText('\u0003', false); } catch { /* ignore */ }
        }
        this.channel.appendLine('⏹ Cancelamento solicitado.');
    }

    // ---------- Descoberta do comando ----------

    private resolveSteps(): string[] | null {
        const cfg = vscode.workspace.getConfiguration('deepseekContextSync');
        const explicit = cfg.get<string>('runCommand', '').trim();
        if (explicit) return explicit.split(/\s*&&\s*/).filter(Boolean);

        // 1) workspaceRoot/package.json
        const rootPkg = path.join(this.workspaceRoot, 'package.json');
        if (fs.existsSync(rootPkg)) {
            const r = this.stepsFromPackageJson(rootPkg, '');
            if (r) return r;
        }

        // 2) subpastas diretas com package.json (vscode-extension/, etc.)
        try {
            for (const name of fs.readdirSync(this.workspaceRoot).sort()) {
                const sub = path.join(this.workspaceRoot, name);
                try {
                    if (!fs.statSync(sub).isDirectory()) continue;
                } catch { continue; }
                const pkg = path.join(sub, 'package.json');
                if (!fs.existsSync(pkg)) continue;
                const r = this.stepsFromPackageJson(pkg, name);
                if (r) return r;
            }
        } catch { /* ignore */ }

        // 3) outras famílias na raiz
        if (fs.existsSync(path.join(this.workspaceRoot, 'Cargo.toml'))) return ['cargo check'];
        if (fs.existsSync(path.join(this.workspaceRoot, 'go.mod'))) return ['go build ./...'];

        const hasPyProject = fs.existsSync(path.join(this.workspaceRoot, 'pyproject.toml'));
        const hasReqTxt = fs.existsSync(path.join(this.workspaceRoot, 'requirements.txt'));
        if (hasPyProject || hasReqTxt) {
            const hasPytest = fs.existsSync(path.join(this.workspaceRoot, 'pytest.ini'))
                || fs.existsSync(path.join(this.workspaceRoot, 'tests'));
            return [hasPytest ? 'python -m pytest -q' : 'python -m compileall -q .'];
        }

        return null;
    }

    /**
     * @param pkgPath caminho absoluto do package.json
     * @param subdir  nome da subpasta relativo ao workspaceRoot ('' quando é o próprio root)
     */
    private stepsFromPackageJson(pkgPath: string, subdir: string): string[] | null {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            const scripts = pkg && pkg.scripts ? pkg.scripts : {};
            if (!scripts.build && !scripts.check && !scripts.test && !scripts.compile) return null;

            const cd = subdir ? `cd "${subdir}" && ` : '';
            const steps: string[] = [];
            if (this.needsNpmInstall(pkgPath, pkg, subdir)) {
                steps.push(`${cd}npm install --no-audit --no-fund`);
            }
            if (scripts.build) steps.push(`${cd}npm run build`);
            else if (scripts.check) steps.push(`${cd}npm run check`);
            else if (scripts.test) steps.push(`${cd}npm test`);
            else if (scripts.compile) steps.push(`${cd}npm run compile`);
            return steps.length > 0 ? steps : null;
        } catch {
            return null;
        }
    }

    private needsNpmInstall(pkgPath: string, pkg: any, subdir: string): boolean {
        const hasDeps = Object.keys(pkg?.dependencies ?? {}).length
            + Object.keys(pkg?.devDependencies ?? {}).length > 0;
        if (!hasDeps) return false;
        const baseDir = subdir ? path.join(this.workspaceRoot, subdir) : this.workspaceRoot;
        const nm = path.join(baseDir, 'node_modules');
        if (!fs.existsSync(nm)) return true;
        try {
            return fs.statSync(pkgPath).mtimeMs > fs.statSync(nm).mtimeMs;
        } catch {
            return false;
        }
    }

    private childEnv(): NodeJS.ProcessEnv {
        return {
            CI: '1', FORCE_COLOR: '0', NO_COLOR: '1',
            NEXT_TELEMETRY_DISABLED: '1', npm_config_yes: 'true', ADBLOCK: '1'
        };
    }

    // ---------- Execução ----------

    async run(): Promise<RunResult> {
        this.abortRequested = false;

        const steps = this.resolveSteps();
        if (!steps) {
            return {
                success: true, command: '', durationMs: 0, via: 'none',
                output: '(Nenhum comando de execução configurado nem detectado. Configure "deepseekContextSync.runCommand" para que o agente possa validar o código.)'
            };
        }

        const cfg = vscode.workspace.getConfiguration('deepseekContextSync');
        const totalMs = getTimeouts().run * 1000;
        const useTerminal = cfg.get<boolean>('runInTerminal', true);
        const command = steps.join(' && ');
        const start = Date.now();
        let log = '';
        let via: 'terminal' | 'process' = 'process';

        this.channel.appendLine(`\n=== ${new Date().toLocaleTimeString()}  ${command}  (pasta: ${this.workspaceRoot}) ===`);

        for (const step of steps) {
            if (this.abortRequested) {
                log += `\n[Cancelado pelo usuário antes de "${step}"]`;
                return this.finish(false, command, log, start, null, via, true);
            }

            const remaining = totalMs - (Date.now() - start);
            if (remaining <= 0) {
                log += `\n[Tempo total esgotado após ${totalMs / 1000}s]`;
                return this.finish(false, command, log, start, null, via, false);
            }

            let r: StepResult | null = null;
            if (useTerminal) {
                r = await this.runStepInTerminal(step, remaining);
                if (r && !r.success && !r.aborted && POLICY_BLOCK_RE.test(r.output)) {
                    this.channel.appendLine('(PowerShell bloqueou scripts; repetindo pelo processo em segundo plano)');
                    r = null;
                }
                if (r) via = 'terminal';
            }
            if (!r) {
                via = 'process';
                r = await this.runStepSpawn(step, Math.max(5000, totalMs - (Date.now() - start)));
            }

            log += `$ ${step}\n${r.output}\n`;
            this.channel.appendLine(`[${step}] terminou com código ${r.exitCode}${r.aborted ? ' (cancelado)' : ''}`);

            if (r.aborted || this.abortRequested) {
                return this.finish(false, command, log, start, r.exitCode, via, true);
            }
            if (!r.success) {
                return this.finish(false, command, log, start, r.exitCode, via, false);
            }
        }
        return this.finish(true, command, log, start, 0, via, false);
    }

    private finish(
        success: boolean,
        command: string,
        log: string,
        start: number,
        exitCode: number | null,
        via: 'terminal' | 'process',
        aborted: boolean
    ): RunResult {
        let output = truncateHead(log.trim());
        if (!success && !aborted) {
            const meaningful = output.split('\n')
                .filter(l => l.trim() && !/^>\s/.test(l.trim()) && !/^\$\s/.test(l.trim())).length;
            const header = `[Falhou com código de saída ${exitCode ?? 'desconhecido'} | pasta: ${this.workspaceRoot}]\n`;
            const hint = meaningful === 0
                ? '\n[O comando falhou mas não imprimiu detalhes do erro. Verifique o painel "DeepSeek Agent" ' +
                  '(Saída) / terminal do VS Code. Causas comuns: dependência faltando, script "build" inexistente ou erro de configuração.]'
                : '';
            output = header + output + hint;
        }
        if (aborted) {
            output = `[Cancelado pelo usuário]\n${output}`;
        }
        return { success, command, output, durationMs: Date.now() - start, exitCode, via, aborted };
    }

    private ensureTerminal(): vscode.Terminal {
        if (!this.terminal || this.terminal.exitStatus !== undefined) {
            this.terminal = vscode.window.createTerminal({
                name: 'DeepSeek Agent',
                cwd: this.workspaceRoot,
                env: this.childEnv() as { [key: string]: string }
            });
        }
        return this.terminal;
    }

    private async runStepInTerminal(step: string, timeoutMs: number): Promise<StepResult | null> {
        const w = vscode.window as any;
        if (typeof w.onDidEndTerminalShellExecution !== 'function') return null;

        try {
            const term = this.ensureTerminal();
            term.show(true);

            let si: any = (term as any).shellIntegration;
            if (!si && typeof w.onDidChangeTerminalShellIntegration === 'function') {
                si = await new Promise<any>(resolve => {
                    const timer = setTimeout(() => { sub.dispose(); resolve((term as any).shellIntegration); }, 10000);
                    const sub = w.onDidChangeTerminalShellIntegration((e: any) => {
                        if (e.terminal === term) { clearTimeout(timer); sub.dispose(); resolve(e.shellIntegration); }
                    });
                    if ((term as any).shellIntegration) {
                        clearTimeout(timer); sub.dispose(); resolve((term as any).shellIntegration);
                    }
                });
            }
            if (!si) return null;

            let exec: any;
            let exitCode: number | undefined;
            let endResolve: () => void = () => { /* definido abaixo */ };
            const endPromise = new Promise<void>(r => { endResolve = r; });
            const endSub = w.onDidEndTerminalShellExecution((e: any) => {
                if (exec && e.execution === exec) { exitCode = e.exitCode; endResolve(); }
            });

            exec = si.executeCommand(step);

            let raw = '';
            const reader = (async () => {
                try {
                    for await (const chunk of exec.read()) {
                        raw += chunk;
                        if (raw.length > MAX_OUTPUT * 2) raw = raw.slice(-MAX_OUTPUT * 2);
                    }
                } catch { /* fim do fluxo */ }
            })();

            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                try { term.sendText('\u0003', false); } catch { /* ignore */ }
                endResolve();
            }, timeoutMs);

            const abortPoll = setInterval(() => {
                if (this.abortRequested) {
                    try { term.sendText('\u0003', false); } catch { /* ignore */ }
                }
            }, 500);

            await endPromise;
            clearTimeout(timer);
            clearInterval(abortPoll);
            await Promise.race([reader, sleep(1500)]);
            endSub.dispose();

            const output = cleanTerminalText(raw).trim();
            this.channel.appendLine(output);

            if (this.abortRequested) {
                // FIX BUG CRÍTICO: dispose() mata a árvore de processos do terminal.
                // Só mandar Ctrl+C deixava builds "zumbis" rodando em background,
                // e o próximo `executeCommand` empilhava em cima de um shell travado.
                try { term.dispose(); } catch { /* ignore */ }
                if (this.terminal === term) this.terminal = undefined;
                return { success: false, exitCode: null, aborted: true, output: output + '\n[Cancelado pelo usuário]' };
            }
            if (timedOut) {
                try { term.dispose(); } catch { /* ignore */ }
                if (this.terminal === term) this.terminal = undefined;
                return { success: false, exitCode: null, output: output + `\n[Tempo esgotado após ${Math.round(timeoutMs / 1000)}s; comando interrompido]` };
            }
            if (exitCode === undefined) return null;
            return { success: exitCode === 0, exitCode, output };
        } catch {
            return null;
        }
    }

    private runStepSpawn(step: string, timeoutMs: number): Promise<StepResult> {
        return new Promise<StepResult>(resolve => {
            let output = '';
            let killed = false;
            let child: ChildProcess;
            try {
                child = spawn(step, [], {
                    cwd: this.workspaceRoot,
                    shell: true,
                    windowsHide: true,
                    detached: process.platform !== 'win32',
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: { ...process.env, ...this.childEnv() }
                });
            } catch (e) {
                resolve({ success: false, exitCode: null, output: 'Falha ao iniciar o comando: ' + (e instanceof Error ? e.message : String(e)) });
                return;
            }

            this.currentChild = child;

            const append = (buf: Buffer) => {
                const text = buf.toString('utf8');
                this.channel.append(text);
                output += text;
                if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
            };
            child.stdout?.on('data', append);
            child.stderr?.on('data', append);

            const timer = setTimeout(() => {
                killed = true;
                killTree(child);
            }, timeoutMs);

            child.on('error', err => {
                clearTimeout(timer);
                this.currentChild = null;
                resolve({ success: false, exitCode: null, output: cleanTerminalText(output) + '\n[erro de execução: ' + err.message + ']' });
            });

            child.on('close', code => {
                clearTimeout(timer);
                this.currentChild = null;
                let text = cleanTerminalText(output).trim();
                if (killed) text += `\n[Tempo esgotado após ${Math.round(timeoutMs / 1000)}s]`;
                const aborted = this.abortRequested;
                if (aborted) text += '\n[Cancelado pelo usuário]';
                resolve({
                    success: code === 0 && !killed && !aborted,
                    exitCode: code,
                    output: text,
                    aborted
                });
            });
        });
    }
}
