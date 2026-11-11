import * as vscode from 'vscode';
import * as path from 'path';
import { EXCLUDED_DIRS, isExcludedPath, isProbablyBinary, isInspectableBinary } from './pathRules';
import { ContextBudget } from './intelligence/contextBudget';
import { IndexData } from './indexer';
import { parsePE, formatPEInfo } from './peInspector';
import { decompileAssembly, isFrameworkAssembly, Limiter } from './decompiler';

export type ChangeKind = 'changed' | 'deleted';

export interface ChangeEvent {
    relPath: string;
    kind: ChangeKind;
}

export interface FullResult {
    text: string;
    files: number;
    chars: number;
    omitted: string[];
}

export interface DeltaResult {
    text: string;
    included: string[];
    chars: number;
}

const MAX_FILES_SCAN = 20000;
const MAX_TREE_LINES = 2000;

interface TreeNode {
    dirs: Map<string, TreeNode>;
    files: string[];
}

export class ContextManager {
    private files = new Map<string, string>();
    // Binários (.dll/.exe/...) cujo conteúdo foi resumido em texto pelo
    // peInspector. Ficam separados de `files` porque não são texto puro —
    // o resumo é anexado ao contexto em buildFull/buildFullWithBudget/buildDelta.
    private binaries = new Map<string, string>();
    // Cache do C# descompilado (ILSpy) por arquivo, validado pelo hash do binário.
    private decompileCache = new Map<string, { hash: string; block: string }>();
    // Hash da versão do binário cujo resumo está em `binaries` (descarta resultado atrasado).
    private binaryHash = new Map<string, string>();
    private decompileLimiter = new Limiter(2);
    private decompileCount = 0;
    private ilspyWarned = false;
    private allPaths = new Set<string>();
    private disposables: vscode.Disposable[] = [];

    private readonly _onDidChange = new vscode.EventEmitter<ChangeEvent>();
    private readonly _onDidChangeTree = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;
    readonly onDidChangeTree = this._onDidChangeTree.event;

    constructor(private workspaceRoot: string) {}

    private get maxFileBytes(): number {
        const kb = vscode.workspace.getConfiguration('deepseekContextSync').get<number>('maxFileKB', 300);
        return kb * 1024;
    }

    /** Teto de leitura para binários inspecionáveis (.dll/.exe/...). O conteúdo bruto nunca é enviado. */
    private get maxBinaryBytes(): number {
        const mb = vscode.workspace.getConfiguration('deepseekContextSync').get<number>('maxBinaryMB', 50);
        return mb * 1024 * 1024;
    }

    private get maxTotalChars(): number {
        const kb = vscode.workspace.getConfiguration('deepseekContextSync').get<number>('maxTotalKB', 800);
        return kb * 1024;
    }

    getFile(rel: string): string | undefined {
        return this.files.get(rel);
    }

    getAllFiles(): ReadonlyMap<string, string> {
        return this.files;
    }

    getBinary(rel: string): string | undefined {
        return this.binaries.get(rel);
    }

    getAllBinaries(): ReadonlyMap<string, string> {
        return this.binaries;
    }

    private get decompileEnabled(): boolean {
        return vscode.workspace.getConfiguration('deepseekContextSync').get<boolean>('decompileDotNet', true);
    }

    private get decompileSettings() {
        const cfg = vscode.workspace.getConfiguration('deepseekContextSync');
        return {
            exePath: cfg.get<string>('ilspyPath', 'ilspycmd') || 'ilspycmd',
            maxChars: cfg.get<number>('maxDecompiledKB', 200) * 1024,
            maxAssemblies: cfg.get<number>('maxDecompiledAssemblies', 10),
            timeoutMs: 120_000,
        };
    }

    private get inspectBinariesEnabled(): boolean {
        return vscode.workspace.getConfiguration('deepseekContextSync').get<boolean>('inspectBinaries', true);
    }

    async initialize() {
        const excludeGlob = `{${[...EXCLUDED_DIRS].map(d => `**/${d}/**`).join(',')}}`;
        const uris = await vscode.workspace.findFiles('**/*', excludeGlob, MAX_FILES_SCAN);
        for (const uri of uris) {
            await this.updateFile(uri, false);
        }

        const watcher = vscode.workspace.createFileSystemWatcher('**/*');
        watcher.onDidCreate(uri => this.updateFile(uri, true));
        watcher.onDidChange(uri => this.updateFile(uri, true));
        watcher.onDidDelete(uri => this.handleDelete(uri));
        this.disposables.push(watcher, this._onDidChange, this._onDidChangeTree);
    }

    private toRel(uri: vscode.Uri): string | null {
        const rel = path.relative(this.workspaceRoot, uri.fsPath);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
        return rel.split(path.sep).join('/');
    }

    private async updateFile(uri: vscode.Uri, notify: boolean) {
        const rel = this.toRel(uri);
        if (!rel || isExcludedPath(rel)) return;

        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (!(stat.type & vscode.FileType.File)) return;

            this.addPath(rel, notify);

            // DLLs/EXEs costumam passar de 300 KB; antes eram descartados aqui e
            // nunca chegavam ao inspetor. Binários inspecionáveis têm teto próprio.
            const inspectable = this.inspectBinariesEnabled && isInspectableBinary(rel);
            const sizeLimit = inspectable ? this.maxBinaryBytes : this.maxFileBytes;
            if (stat.size > sizeLimit) {
                this.removeFile(rel, notify);
                if (this.binaries.delete(rel) && notify) {
                    this._onDidChange.fire({ relPath: rel, kind: 'changed' });
                }
                return;
            }

            const bytes = await vscode.workspace.fs.readFile(uri);
            if (!isProbablyBinary(bytes) && stat.size > this.maxFileBytes) {
                // Arquivo de texto grande com extensão "inspecionável": segue o limite de texto.
                this.removeFile(rel, notify);
                return;
            }
            if (isProbablyBinary(bytes)) {
                // Em vez de só descartar, gera um resumo textual do PE
                // (imports/exports/seções). O chat vê o que é o binário sem
                // receber bytes crus.
                this.files.delete(rel);
                if (this.inspectBinariesEnabled && isInspectableBinary(rel)) {
                    try {
                        const info = parsePE(Buffer.from(bytes));
                        if (info) {
                            const summary = formatPEInfo(info, rel);
                            this.binaryHash.set(rel, info.hash);
                            const cached = this.decompileCache.get(rel);
                            const useCache = cached && cached.hash === info.hash;
                            this.binaries.set(rel, useCache ? summary + cached!.block : summary);
                            if (notify) this._onDidChange.fire({ relPath: rel, kind: 'changed' });
                            if (info.isManaged && !useCache && this.decompileEnabled && !isFrameworkAssembly(rel)) {
                                this.scheduleDecompile(rel, uri.fsPath, info.hash, summary);
                            }
                            return;
                        }
                    } catch { /* parser falhou: cai para o comportamento antigo */ }
                }
                if (this.binaries.delete(rel) && notify) {
                    this._onDidChange.fire({ relPath: rel, kind: 'changed' });
                }
                return;
            }

            // Texto: se antes era binário, limpa o cache de resumo.
            this.binaries.delete(rel);

            const content = Buffer.from(bytes).toString('utf8');
            if (this.files.get(rel) === content) return;

            this.files.set(rel, content);
            if (notify) this._onDidChange.fire({ relPath: rel, kind: 'changed' });
        } catch {
            // Ignora arquivos inacessíveis
        }
    }

    /** Decompila em segundo plano com o ILSpy e anexa o C# ao resumo do binário. */
    private scheduleDecompile(rel: string, fsPath: string, hash: string, summary: string) {
        const cfg = this.decompileSettings;
        if (this.decompileCount >= cfg.maxAssemblies) return;
        this.decompileCount++;

        void this.decompileLimiter.run(async () => {
            const res = await decompileAssembly(fsPath, {
                exePath: cfg.exePath,
                maxChars: cfg.maxChars,
                timeoutMs: cfg.timeoutMs,
            });

            if (!res.ok) {
                if (res.reason === 'not-installed' && !this.ilspyWarned) {
                    this.ilspyWarned = true;
                    void vscode.window.showInformationMessage(
                        'DeepSeek Context Sync: para enviar o código das DLLs .NET é preciso o ILSpy em linha de comando. ' +
                        'Instale com: dotnet tool install --global ilspycmd (ou ajuste "deepseekContextSync.ilspyPath").'
                    );
                }
                return;
            }

            // O arquivo pode ter mudado ou sido apagado enquanto decompilava.
            if (!this.allPaths.has(rel) || this.binaryHash.get(rel) !== hash) return;

            const note = res.truncated ? '\n// [código truncado pelo limite "maxDecompiledKB"]' : '';
            const block = `\n\nCódigo C# descompilado (ILSpy):\n${res.code}${note}`;
            this.decompileCache.set(rel, { hash, block });
            this.binaries.set(rel, summary + block);
            this._onDidChange.fire({ relPath: rel, kind: 'changed' });
        });
    }

    private addPath(rel: string, notify: boolean) {
        if (this.allPaths.has(rel)) return;
        this.allPaths.add(rel);
        if (notify) this._onDidChangeTree.fire();
    }

    private removePath(rel: string, notify: boolean) {
        if (this.allPaths.delete(rel) && notify) this._onDidChangeTree.fire();
    }

    private removeFile(rel: string, notify: boolean) {
        if (this.files.delete(rel) && notify) {
            this._onDidChange.fire({ relPath: rel, kind: 'deleted' });
        }
    }

    private handleDelete(uri: vscode.Uri) {
        const rel = this.toRel(uri);
        if (!rel) return;
        this.removeFile(rel, true);
        this.binaries.delete(rel);
        this.decompileCache.delete(rel);
        this.binaryHash.delete(rel);
        this.removePath(rel, true);
        const prefix = rel + '/';
        for (const key of [...this.files.keys()]) {
            if (key.startsWith(prefix)) this.removeFile(key, true);
        }
        for (const key of [...this.binaries.keys()]) {
            if (key.startsWith(prefix)) {
                this.binaries.delete(key);
                this.decompileCache.delete(key);
                this.binaryHash.delete(key);
            }
        }
        for (const key of [...this.allPaths]) {
            if (key.startsWith(prefix)) this.removePath(key, true);
        }
    }

    buildTree(): string {
        const root: TreeNode = { dirs: new Map(), files: [] };
        for (const p of [...this.allPaths].sort()) {
            const parts = p.split('/');
            let node = root;
            for (let i = 0; i < parts.length - 1; i++) {
                let next = node.dirs.get(parts[i]);
                if (!next) {
                    next = { dirs: new Map(), files: [] };
                    node.dirs.set(parts[i], next);
                }
                node = next;
            }
            node.files.push(parts[parts.length - 1]);
        }

        const lines: string[] = [];
        const render = (node: TreeNode, depth: number) => {
            const indent = '  '.repeat(depth);
            for (const name of [...node.dirs.keys()].sort()) {
                lines.push(`${indent}${name}/`);
                render(node.dirs.get(name)!, depth + 1);
            }
            for (const f of node.files.sort()) lines.push(indent + f);
        };
        render(root, 0);

        if (lines.length === 0) return '(vazio)';
        if (lines.length > MAX_TREE_LINES) {
            const extra = lines.length - MAX_TREE_LINES;
            lines.length = MAX_TREE_LINES;
            lines.push(`[+${extra} itens omitidos]`);
        }
        return lines.join('\n');
    }

    buildFull(): FullResult {
        const max = this.maxTotalChars;
        let text = '';
        let files = 0;
        const omitted: string[] = [];

        for (const rel of [...this.files.keys()].sort()) {
            const block = `\n--- ${rel} ---\n${this.files.get(rel)}\n`;
            if (text.length + block.length > max) {
                omitted.push(rel);
                continue;
            }
            text += block;
            files++;
        }

        // Binários resumidos entram depois do código-fonte (mesmo orçamento).
        for (const rel of [...this.binaries.keys()].sort()) {
            const summary = this.binaries.get(rel);
            if (!summary) continue;
            const block = `\n--- BINÁRIO (PE): ${rel} ---\n${summary}\n`;
            if (text.length + block.length > max) {
                omitted.push(rel);
                continue;
            }
            text += block;
            files++;
        }

        if (omitted.length > 0) {
            text += `\n[Omitidos por limite de tamanho (${omitted.length}): ${omitted.slice(0, 80).join(', ')}]\n`;
            text += `[Aumente "deepseekContextSync.maxTotalKB" nas configurações se precisar enviar mais arquivos.]\n`;
        }
        return { text, files, chars: text.length, omitted };
    }

    /**
     * Contexto completo ordenado por importância, com orçamento de tokens.
     * Entradas priorizam entry points, configs, READMEs e hubs; o resto vai até
     * o limite. Requer o índice (IndexData) para conhecer os tamanhos.
     */
    buildFullWithBudget(maxTokens: number, index: IndexData): FullResult {
        const budget = new ContextBudget(index);
        const result = budget.compute(maxTokens);
        const { ordered, omitted } = result;
        let used = result.totalTokens;
        let text = '';
        let files = 0;
        for (const f of ordered) {
            const content = this.files.get(f.path);
            if (content === undefined) continue;
            text += `\n--- ${f.path} ---\n${content}\n`;
            files++;
        }

        // Binários resumidos entram depois do texto, sob o mesmo orçamento.
        const binOmitted: string[] = [];
        for (const rel of [...this.binaries.keys()].sort()) {
            const summary = this.binaries.get(rel);
            if (!summary) continue;
            const block = `\n--- BINÁRIO (PE): ${rel} ---\n${summary}\n`;
            const est = Math.ceil(block.length / 4);
            if (used + est > maxTokens) {
                binOmitted.push(rel);
                continue;
            }
            text += block;
            files++;
            used += est;
        }

        const allOmitted = [...omitted, ...binOmitted];
        if (allOmitted.length > 0) {
            text += `\n[Omitidos por orçamento (${allOmitted.length}): ${allOmitted.slice(0, 80).join(', ')}]\n`;
            text += `[Aumente "deepseekContextSync.maxContextTokens" ou "maxTotalKB" para incluir mais.]\n`;
        }
        return { text, files, chars: text.length, omitted: allOmitted };
    }

    buildDelta(pending: Map<string, ChangeKind>): DeltaResult {
        const max = this.maxTotalChars;
        let text = '';
        const included: string[] = [];

        for (const [rel, kind] of pending) {
            const content = this.files.get(rel);
            const bin = this.binaries.get(rel);
            let block: string;
            if (kind === 'deleted' || (content === undefined && bin === undefined)) {
                block = `\n--- REMOVIDO: ${rel} ---\n`;
            } else if (content === undefined && bin !== undefined) {
                block = `\n--- BINÁRIO (PE): ${rel} ---\n${bin}\n`;
            } else if (content !== undefined) {
                block = `\n--- ALTERADO: ${rel} ---\n${content}\n`;
            } else {
                block = `\n--- REMOVIDO: ${rel} ---\n`;
            }

            if (included.length > 0 && text.length + block.length > max) continue;

            text += block;
            included.push(rel);
        }
        return { text, included, chars: text.length };
    }

    dispose() {
        this.disposables.forEach(d => d.dispose());
    }
}
