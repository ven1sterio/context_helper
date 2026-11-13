import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { parsePE, PEInfo } from './peInspector';
import { decompileAssembly, decompileType, isSafeTypeName } from './decompiler';

/**
 * Engenharia reversa de binários (DLL/EXE) a pedido da IA do chat.
 *
 *  - Nativo (C/C++): Ghidra headless (info/functions/decompile/disasm/xrefs/strings/asm).
 *    A análise pesada é feita UMA vez por arquivo e guardada em uma pasta de cache SEM segmentos iniciados por ponto (o Ghidra recusa esses caminhos).
 *  - .NET: ILSpy (ilspycmd) por tipo, mais os metadados do peInspector.
 *  - patch: troca de bytes de mesmo tamanho direto no PE (nativo ou .NET), com conferência dos
 *    bytes originais, cópia por padrão e aprovação do usuário.
 *
 * Não depende do módulo `vscode` (testável isoladamente): a aprovação chega por `ctx.confirm`.
 */

export const RE_OPS = ['info', 'functions', 'decompile', 'disasm', 'xrefs', 'strings', 'asm', 'patch'] as const;
export type ReOp = typeof RE_OPS[number];

export interface ReRequest {
    op: ReOp;
    file: string;
    args: string[];
    opts: Record<string, string>;
}

export interface ReContext {
    workspaceRoot: string;
    /** Pasta do Ghidra (a que contém support/analyzeHeadless). */
    ghidraHome?: string;
    ilspyPath?: string;
    maxDecompiledChars?: number;
    /** Aprovação do usuário para gravar patch. Sem ela, nenhum patch é aplicado. */
    confirm?: (message: string) => Promise<boolean>;
    /** Pasta com ReBridge.java (padrão: <extensão>/ghidra). */
    scriptDir?: string;
    /** Cache dos projetos Ghidra. Não pode ter segmento começando com "."; se tiver, usa a pasta temporária. */
    cacheDir?: string;
}

export interface ReResult { op: string; ok: boolean; text: string }
export interface ReResponse { ok: boolean; text: string; results: ReResult[] }

const BINARY_EXT = new Set(['.dll', '.exe', '.sys', '.ocx', '.node', '.so', '.dylib']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.deepseek-sync']);
const MAX_RESULT_CHARS = 14000;
const MAX_REQUESTS = 8;
const SHELL_UNSAFE = /["%^&|<>!`$;]/;

// ---------------------------------------------------------------- caminhos
function insideRoot(root: string, abs: string): boolean {
    const r = path.relative(root, abs);
    return !(r.startsWith('..') || path.isAbsolute(r));
}

/** Resolve o arquivo pedido: caminho relativo ao workspace ou só o nome (busca até 6 níveis). */
export function locateBinary(root: string, name: string): string {
    const ext = path.extname(name).toLowerCase();
    if (!BINARY_EXT.has(ext)) throw new Error(`extensão não suportada: ${ext || '(nenhuma)'}`);
    const direct = path.resolve(root, name);
    if (!insideRoot(root, direct)) throw new Error('caminho fora do workspace: ' + name);
    if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;

    const base = path.basename(name).toLowerCase();
    const hits: string[] = [];
    const walk = (dir: string, depth: number) => {
        if (depth > 6 || hits.length > 5) return;
        let ents: fs.Dirent[];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
            if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1); }
            else if (e.name.toLowerCase() === base) hits.push(path.join(dir, e.name));
        }
    };
    walk(root, 0);
    if (hits.length === 0) throw new Error('arquivo não encontrado no workspace: ' + name);
    if (hits.length > 1) {
        throw new Error('nome ambíguo, use o caminho relativo. Candidatos:\n' +
            hits.map(h => '  ' + path.relative(root, h).replace(/\\/g, '/')).join('\n'));
    }
    return hits[0];
}

// ---------------------------------------------------------------- PE (patch)
interface PeLayout {
    imageBase: bigint;
    sections: Array<{ name: string; vsize: number; va: number; rawSize: number; rawPtr: number }>;
}

export function readPeLayout(buf: Buffer): PeLayout {
    if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5A4D) throw new Error('não é um PE (falta "MZ")');
    const pe = buf.readUInt32LE(0x3C);
    if (pe + 24 > buf.length || buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('não é um PE (falta "PE")');
    const nsec = buf.readUInt16LE(pe + 6);
    const optSize = buf.readUInt16LE(pe + 20);
    const opt = pe + 24;
    const is64 = buf.readUInt16LE(opt) === 0x20b;
    const imageBase = is64 ? buf.readBigUInt64LE(opt + 24) : BigInt(buf.readUInt32LE(opt + 28));
    const sections: PeLayout['sections'] = [];
    let sh = opt + optSize;
    for (let i = 0; i < nsec; i++, sh += 40) {
        if (sh + 40 > buf.length) break;
        sections.push({
            name: buf.toString('latin1', sh, sh + 8).replace(/\0+$/, ''),
            vsize: buf.readUInt32LE(sh + 8),
            va: buf.readUInt32LE(sh + 12),
            rawSize: buf.readUInt32LE(sh + 16),
            rawPtr: buf.readUInt32LE(sh + 20),
        });
    }
    return { imageBase, sections };
}

export function rvaToFileOffset(pe: PeLayout, rva: number): { offset: number; section: string } {
    for (const s of pe.sections) {
        const span = Math.min(s.vsize || s.rawSize, s.rawSize);
        if (rva >= s.va && rva < s.va + span) return { offset: s.rawPtr + (rva - s.va), section: s.name };
    }
    const first = pe.sections.length ? Math.min(...pe.sections.map(s => s.va)) : 0;
    if (rva < first) return { offset: rva, section: '(cabeçalho)' };
    throw new Error('RVA 0x' + rva.toString(16) + ' não está mapeada em disco (seção sem dados, ex.: .bss)');
}

function parseHexBytes(s: string, label: string): Buffer {
    const clean = String(s).replace(/0x/gi, '').replace(/[\s,]+/g, '');
    if (!/^([0-9a-f]{2})+$/i.test(clean)) throw new Error(`${label}: bytes hex inválidos`);
    return Buffer.from(clean, 'hex');
}
const hex = (b: Buffer): string => [...b].map(x => x.toString(16).padStart(2, '0')).join(' ').toUpperCase();

function parseBigInt(v: string, label: string): bigint {
    try { return BigInt(v.trim()); } catch { throw new Error(`${label}: número inválido (${v})`); }
}

async function opPatch(req: ReRequest, ctx: ReContext): Promise<string> {
    const file = locateBinary(ctx.workspaceRoot, req.file);
    const buf = fs.readFileSync(file);
    const pe = readPeLayout(buf);
    const o = req.opts;

    let offset: number;
    let where: string;
    if (o.offset) {
        offset = Number(parseBigInt(o.offset, 'offset'));
        where = 'offset 0x' + offset.toString(16);
    } else {
        const rvaBig = o.rva ? parseBigInt(o.rva, 'rva') : parseBigInt(o.addr, 'addr') - pe.imageBase;
        if (rvaBig < 0n) throw new Error('addr abaixo do imagebase 0x' + pe.imageBase.toString(16));
        const rva = Number(rvaBig);
        const r = rvaToFileOffset(pe, rva);
        offset = r.offset;
        where = `RVA 0x${rva.toString(16)} (${r.section}, offset 0x${offset.toString(16)})`;
    }

    const expect = parseHexBytes(o.expect ?? '', 'expect');
    const write = parseHexBytes(o.write ?? '', 'write');
    if (expect.length !== write.length) throw new Error(`expect (${expect.length}) e write (${write.length}) precisam ter o mesmo tamanho`);
    if (write.length === 0 || write.length > 256) throw new Error('tamanho do patch deve ser de 1 a 256 bytes');
    if (offset < 0 || offset + write.length > buf.length) throw new Error('offset fora do arquivo');
    const actual = buf.subarray(offset, offset + expect.length);
    if (!actual.equals(expect)) {
        throw new Error(`os bytes atuais em ${where} NÃO são os esperados.\n  esperado: ${hex(expect)}\n  atual:    ${hex(Buffer.from(actual))}\nNada foi gravado.`);
    }

    const inPlace = String(o.inplace ?? '').toLowerCase() === 'true';
    const ext = path.extname(file);
    const target = inPlace ? file : file.slice(0, -ext.length) + '.patched' + ext;
    const msg = `Aplicar patch em ${path.basename(file)}?\n${where}\n${hex(expect)}  →  ${hex(write)}\n` +
        `Destino: ${inPlace ? 'O PRÓPRIO ARQUIVO (backup .orig)' : path.basename(target) + ' (cópia)'}`;
    if (!ctx.confirm || !(await ctx.confirm(msg))) {
        return 'Patch NÃO aplicado: o usuário recusou (ou não há aprovação disponível).';
    }

    if (inPlace && !fs.existsSync(file + '.orig')) fs.copyFileSync(file, file + '.orig');
    const out = Buffer.from(buf);
    write.copy(out, offset);
    fs.writeFileSync(target, out);
    return `Patch aplicado em ${path.relative(ctx.workspaceRoot, target).replace(/\\/g, '/')}\n` +
        `${where}: ${hex(expect)} → ${hex(write)}\n` +
        'Aviso: assinatura digital e checksum do PE ficam inválidos; teste a cópia antes de substituir o original.';
}

// ---------------------------------------------------------------- .NET (ILSpy)
function dotnetUnsupported(op: string): string {
    return `A operação "${op}" não existe para binários .NET. Use decompile <Namespace.Classe> (C#) ou ` +
        'disasm <Namespace.Classe> (IL); para ver nomes, functions filter=... ou strings "texto".';
}

async function opManaged(req: ReRequest, ctx: ReContext, file: string, info: PEInfo): Promise<string> {
    const target = req.args[0] ?? '';
    const filter = (req.opts.filter ?? target).toLowerCase();
    const limit = Math.min(parseInt(req.opts.limit ?? '', 10) || 100, 500);
    const exe = ctx.ilspyPath || 'ilspycmd';
    const maxChars = ctx.maxDecompiledChars ?? 200 * 1024;

    switch (req.op) {
        case 'info':
            return [
                'formato: PE .NET (gerenciado)',
                `arquitetura: ${info.machine}`, `runtime: ${info.clrVersion}`,
                `tipo: ${info.isDll ? 'DLL' : info.isExe ? 'EXE' : 'desconhecido'}`,
                `nomes nos metadados: ${info.dotnetNames.length}`, `literais de string: ${info.dotnetUserStrings.length}`,
                'seções:', ...info.sections.map(s => `  ${s.name}  va=0x${s.virtualAddress.toString(16)}  tam=${s.rawSize}`),
            ].join('\n');
        case 'functions': {
            const hits = info.dotnetNames.filter(n => !filter || n.toLowerCase().includes(filter));
            return hits.slice(0, limit).join('\n') + `\n-- ${Math.min(hits.length, limit)} de ${hits.length} nome(s) (tipos, métodos, campos)`;
        }
        case 'strings': {
            const hits = info.dotnetUserStrings.filter(s => s.toLowerCase().includes(target.toLowerCase()));
            return hits.slice(0, 30).map(s => `"${s.replace(/\n/g, '\\n')}"`).join('\n') + `\n-- ${Math.min(hits.length, 30)} de ${hits.length} literal(is)`;
        }
        case 'decompile':
        case 'disasm': {
            const il = req.op === 'disasm';
            const base = { exePath: exe, maxChars, timeoutMs: 120_000 };
            const whole = target === '*' || target.toLowerCase() === 'all';
            if (!whole && !isSafeTypeName(target)) throw new Error('nome de tipo inválido; use Namespace.Classe');
            const r = whole
                ? await decompileAssembly(file, base, il ? ['-il'] : [])
                : await decompileType(file, target, { ...base, il });
            if (!r.ok) {
                if (r.reason === 'not-installed') throw new Error('ilspycmd não instalado (dotnet tool install --global ilspycmd).');
                throw new Error(`ILSpy falhou (${r.reason}): ${r.detail}. Confira o nome completo do tipo com "functions filter=...".`);
            }
            return r.code + (r.truncated ? '\n… [cortado]' : '');
        }
        default:
            return dotnetUnsupported(req.op);
    }
}

// ---------------------------------------------------------------- Ghidra (nativo)
let queue: Promise<unknown> = Promise.resolve(); // o projeto Ghidra trava: uma execução por vez
function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
}

function quoteCmdArg(value: string): string {
    if (SHELL_UNSAFE.test(value) || /[\r\n]/.test(value)) {
        throw new Error('caractere inseguro no caminho ou argumento do Ghidra: ' + value);
    }
    return `"${value}"`;
}

/**
 * Encerra o processo do Ghidra e seus descendentes.
 * No Windows, o analyzeHeadless.bat inicia processos Java filhos, por isso
 * encerrar somente o cmd.exe deixaria a análise rodando em segundo plano.
 */
function killProcessTree(child: ReturnType<typeof spawn>): void {
    const pid = child.pid;

    if (!pid) {
        try { child.kill(); } catch { /* ignore */ }
        return;
    }

    if (process.platform === 'win32') {
        const killer = spawn(
            'taskkill',
            ['/PID', String(pid), '/T', '/F'],
            { windowsHide: true, stdio: 'ignore' }
        );
        killer.once('error', () => {
            try { child.kill(); } catch { /* ignore */ }
        });
        killer.once('close', code => {
            if (code !== 0) {
                try { child.kill(); } catch { /* ignore */ }
            }
        });
        return;
    }

    try {
        process.kill(-pid, 'SIGKILL');
    } catch {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
}

/**
 * Executa o Ghidra Headless.
 *
 * Linux/macOS: executa diretamente, sem shell.
 * Windows: analyzeHeadless.bat exige cmd.exe. Os argumentos são colocados
 * entre aspas individualmente e caracteres de shell são recusados.
 */
function runProcess(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; tail: string }> {
    return new Promise((resolve, reject) => {
        const win = process.platform === 'win32';

        let executable = cmd;
        let spawnArgs = args;

        if (win) {
            try {
                const command = [cmd, ...args].map(quoteCmdArg).join(' ');
                executable = process.env.ComSpec || 'cmd.exe';
                spawnArgs = ['/d', '/s', '/c', `"${command}"`];
            } catch (e) {
                reject(e);
                return;
            }
        }

        const child = spawn(executable, spawnArgs, {
            windowsHide: true,
            windowsVerbatimArguments: win,
            detached: !win
        });

        let tail = '';
        let timedOut = false;

        const keep = (d: Buffer) => {
            tail = (tail + d.toString()).slice(-6000);
        };

        child.stdout.on('data', keep);
        child.stderr.on('data', keep);

        const timer = setTimeout(() => {
            timedOut = true;
            killProcessTree(child);
        }, timeoutMs);

        child.once('error', e => {
            clearTimeout(timer);
            reject(new Error(`Não foi possível iniciar o Ghidra: ${e.message}`));
        });

        child.once('close', code => {
            clearTimeout(timer);

            if (timedOut) {
                reject(new Error(
                    'Ghidra excedeu o tempo limite. O processo e seus descendentes foram encerrados.\n' +
                    tail.slice(-1500)
                ));
                return;
            }

            resolve({ code, tail });
        });
    });
}

/**
 * Confere se o ReBridge.java realmente executou a operação.
 * O código de saída do launcher sozinho não basta: scripts Java podem
 * capturar uma exceção, gravar o erro no arquivo e terminar com código zero.
 */
export function validateGhidraOutput(raw: string): string {
    const output = String(raw ?? '').replace(/^\uFEFF/, '').trim();

    if (!output) {
        throw new Error('Ghidra terminou, mas o ReBridge.java gerou uma saída vazia.');
    }

    const errorLine = output
        .split(/\r?\n/)
        .find(line => line.trimStart().startsWith('[[RE_BRIDGE_ERROR]]'));

    if (errorLine) {
        throw new Error(
            'O script ReBridge.java reportou uma falha: ' +
            errorLine.replace('[[RE_BRIDGE_ERROR]]', '').trim()
        );
    }

    return output;
}

/** O Ghidra rejeita (IllegalArgumentException) qualquer segmento de caminho do projeto que comece com ".". */
export function hasDotSegment(p: string): boolean {
    return p.split(/[\\/]+/).some(seg => seg.startsWith('.') && seg !== '.' && seg !== '..');
}

/** Escolhe a pasta do projeto Ghidra garantindo que nenhum segmento comece com ponto. */
export function resolveGhidraCacheDir(ctx: ReContext): string {
    const candidates = [ctx.cacheDir, path.join(os.tmpdir(), 'deepseek-sync-re')].filter((c): c is string => !!c);
    for (const c of candidates) if (!hasDotSegment(c)) return c;
    throw new Error(
        'Nenhuma pasta de cache válida para o projeto Ghidra: todas têm um segmento começando com ".". Tentadas:\n' +
        candidates.map(c => '  ' + c).join('\n')
    );
}

function runGhidra(req: ReRequest, ctx: ReContext, file: string): Promise<string> {
    return serialize(async () => {
        if (!ctx.ghidraHome) {
            throw new Error(
                'Ghidra não configurado: defina "deepseekContextSync.ghidraPath" ' +
                '(ou a variável GHIDRA_HOME) com a pasta do Ghidra e instale o JDK ' +
                'exigido pela versão instalada.'
            );
        }
        const launcher = path.join(ctx.ghidraHome, 'support', process.platform === 'win32' ? 'analyzeHeadless.bat' : 'analyzeHeadless');
        if (!fs.existsSync(launcher)) throw new Error('analyzeHeadless não encontrado em ' + launcher);

        const st = fs.statSync(file);
        const key = crypto.createHash('sha1').update(file + '|' + st.size + '|' + st.mtimeMs).digest('hex').slice(0, 12);
        const cache = path.join(resolveGhidraCacheDir(ctx), 'ghidra');
        fs.mkdirSync(cache, { recursive: true });
        const proj = 'p_' + key;
        const marker = path.join(cache, proj + '.analyzed');
        const first = !fs.existsSync(marker);

        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 're-'));
        const reqFile = path.join(tmp, 'req.txt');
        const outFile = path.join(tmp, 'out.txt');
        const lines = [`op=${req.op}`, 'target=' + (req.args[0] ?? '').replace(/[\r\n]+/g, ' ')];
        for (const [k, v] of Object.entries(req.opts)) lines.push(`${k.replace(/[^a-z_]/g, '')}=${String(v).replace(/[\r\n]+/g, ' ')}`);
        fs.writeFileSync(reqFile, lines.join('\n') + '\n', 'utf8');

        const args = first
            ? [cache, proj, '-import', file, '-overwrite']
            : [cache, proj, '-process', path.basename(file), '-noanalysis', '-readOnly'];
        args.push('-scriptPath', ctx.scriptDir ?? path.join(__dirname, '..', 'ghidra'), '-postScript', 'ReBridge.java', reqFile, outFile);

        try {
            const { code, tail } = await runProcess(
                launcher,
                args,
                first ? 30 * 60_000 : 5 * 60_000
            );

            if (code !== 0) {
                const dotHint = /Path element starting with '\.'/.test(tail)
                    ? '\nCAUSA: algum segmento do caminho do projeto Ghidra começa com ".". ' +
                      `Caminho usado: ${cache}. Defina outra pasta ou mova o workspace.\n`
                    : '';
                throw new Error(
                    `Ghidra encerrou com código ${code}.${dotHint}\n` +
                    tail.slice(-2000)
                );
            }

            if (!fs.existsSync(outFile)) {
                throw new Error(
                    `Ghidra terminou sem gerar o arquivo de resultado.\n` +
                    tail.slice(-2000)
                );
            }

            const output = validateGhidraOutput(
                fs.readFileSync(outFile, 'utf8')
            );

            // Só marca o projeto como analisado depois de validar a saída.
            if (first) {
                fs.writeFileSync(marker, new Date().toISOString());
            }

            return output;
        } finally {
            try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    });
}

// ---------------------------------------------------------------- entrada
function clip(text: string, max: number): string {
    if (text.length <= max) return text;
    return text.slice(0, max) + `\n… [cortado: ${text.length - max} caracteres a mais. Refine o pedido (filter=, count=, outra função).]`;
}

async function handleOne(req: ReRequest, ctx: ReContext): Promise<string> {
    if (req.op === 'patch') return opPatch(req, ctx);
    const file = locateBinary(ctx.workspaceRoot, req.file);
    const buf = fs.readFileSync(file);
    const info = parsePE(buf);
    if (!info) throw new Error('não é um executável PE válido (.dll/.exe do Windows). Binários ELF/Mach-O não são suportados aqui.');
    if (info.isManaged) return opManaged(req, ctx, file, info);
    return runGhidra(req, ctx, file);
}

/** Executa os pedidos em sequência e devolve um texto único para o chat. */
export async function handleReRequests(requests: ReRequest[], ctx: ReContext): Promise<ReResponse> {
    const list = requests.slice(0, MAX_REQUESTS);
    const per = Math.max(2500, Math.floor(MAX_RESULT_CHARS / Math.max(1, list.length)));
    const results: ReResult[] = [];
    const parts: string[] = [];
    for (const req of list) {
        const head = `=== RE ${req.op} ${req.file}${req.args.length ? ' ' + req.args.join(' ') : ''} ===`;
        try {
            const text = clip(String(await handleOne(req, ctx)).trim(), per);
            results.push({ op: req.op, ok: true, text });
            parts.push(head + '\n' + text);
        } catch (e) {
            const text = 'ERRO: ' + (e instanceof Error ? e.message : String(e));
            results.push({ op: req.op, ok: false, text });
            parts.push(head + '\n' + text);
        }
    }
    return { ok: results.every(r => r.ok), text: parts.join('\n\n'), results };
}
