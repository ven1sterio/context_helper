import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { isExcludedPath } from './pathRules';

const INDEX_VERSION = 1;
const INDEX_DIR = '.deepseek-sync';
const INDEX_FILE = 'index.json';
const SAVE_DEBOUNCE_MS = 1500;

export type SymbolKind =
    | 'function' | 'class' | 'const' | 'let' | 'var'
    | 'interface' | 'type' | 'enum' | 'other';

export interface SymbolInfo {
    name: string;
    kind: SymbolKind;
    start: number;
    end: number;
}

export interface FileEntry {
    path: string;
    tokens: number;
    sha1: string;
    imports: string[];
    exports: string[];
    symbols: SymbolInfo[];
    summary: string | null;
    tags: string[];
}

export interface IndexData {
    version: number;
    workspaceRoot: string;
    generatedAt: string;
    files: Record<string, FileEntry>;
}

export interface FileContentProvider {
    getFile(rel: string): string | undefined;
    getAllFiles(): ReadonlyMap<string, string>;
}

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

function sha1Of(text: string): string {
    return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

function dedupe<T>(arr: T[]): T[] {
    return [...new Set(arr)];
}

function classifyPath(rel: string): 'tsjs' | 'py' | 'other' {
    const ext = path.posix.extname(rel).toLowerCase();
    if (['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'tsjs';
    if (['.py', '.pyi'].includes(ext)) return 'py';
    return 'other';
}

function pythonBlockEnd(lines: string[], startIdx: number, baseIndent: number): number {
    let lastContent = startIdx;
    for (let j = startIdx + 1; j < lines.length; j++) {
        const next = lines[j];
        if (!next.trim()) continue;
        const nextIndent = next.length - next.trimStart().length;
        if (nextIndent <= baseIndent) break;
        lastContent = j;
    }
    return lastContent;
}

function findBlockEnd(lines: string[], startIdx: number): number {
    let depth = 0;
    let foundOpen = false;
    for (let i = startIdx; i < lines.length; i++) {
        const line = lines[i];
        for (const ch of line) {
            if (ch === '{') { depth++; foundOpen = true; }
            else if (ch === '}') {
                depth--;
                if (foundOpen && depth === 0) return i + 1;
            }
        }
        if (!foundOpen && i > startIdx + 10) return startIdx + 1;
    }
    return lines.length;
}

function extractTsJs(text: string): { imports: string[]; exports: string[]; symbols: SymbolInfo[] } {
    const lines = text.split('\n');
    const imports: string[] = [];
    const exports: string[] = [];
    const symbols: SymbolInfo[] = [];

    const importRe = /^\s*import\s+(?:(?:[\w*{}\s,$]+?)\s+from\s+)?['"]([^'"]+)['"]/;
    const dynImportRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/;
    const requireRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/;
    const exportFromRe = /^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/;

    const fnRe = /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/;
    const classRe = /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/;
    const constRe = /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)/;
    const ifaceRe = /^\s*(?:export\s+)?interface\s+(\w+)/;
    const typeRe = /^\s*(?:export\s+)?type\s+(\w+)\s*=/;
    const enumRe = /^\s*(?:export\s+)?enum\s+(\w+)/;
    const exportListRe = /^\s*export\s+(?:type\s+)?\{([^}]+)\}/;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

        const impM = importRe.exec(line) || exportFromRe.exec(line);
        if (impM) imports.push(impM[1]);
        else {
            const dyn = dynImportRe.exec(line);
            if (dyn) imports.push(dyn[1]);
            const req = requireRe.exec(line);
            if (req) imports.push(req[1]);
        }

        const listM = exportListRe.exec(line);
        if (listM) {
            for (const part of listM[1].split(',')) {
                const name = part.trim().split(/\s+as\s+/)[0].trim();
                if (name) exports.push(name);
            }
        }

        let m: RegExpExecArray | null;
        let kind: SymbolKind | null = null;
        let symName = '';
        if ((m = fnRe.exec(line))) { kind = 'function'; symName = m[1]; }
        else if ((m = classRe.exec(line))) { kind = 'class'; symName = m[1]; }
        else if ((m = ifaceRe.exec(line))) { kind = 'interface'; symName = m[1]; }
        else if ((m = typeRe.exec(line))) { kind = 'type'; symName = m[1]; }
        else if ((m = enumRe.exec(line))) { kind = 'enum'; symName = m[1]; }
        else if ((m = constRe.exec(line))) { kind = 'const'; symName = m[1]; }

        if (kind && symName) {
            const start = i + 1;
            const end = findBlockEnd(lines, i);
            symbols.push({ name: symName, kind, start, end });
            if (/^\s*export\s+/.test(line)) exports.push(symName);
        }
    }

    return { imports: dedupe(imports), exports: dedupe(exports), symbols };
}

function extractPy(text: string): { imports: string[]; exports: string[]; symbols: SymbolInfo[] } {
    const lines = text.split('\n');
    const imports: string[] = [];
    const exports: string[] = [];
    const symbols: SymbolInfo[] = [];

    const fromRe = /^\s*from\s+([\w.]+)\s+import\s+(.+)$/;
    const importRe = /^\s*import\s+([\w.]+)/;
    const defRe = /^\s*(?:async\s+)?def\s+(\w+)/;
    const classRe = /^\s*class\s+(\w+)/;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trimStart();
        if (trimmed.startsWith('#')) continue;

        const fromM = fromRe.exec(line);
        if (fromM) {
            imports.push(fromM[1]);
            for (const part of fromM[2].split(',')) {
                const name = part.trim().split(/\s+as\s+/)[0].trim();
                if (name && name !== '*' && name !== '(' && name !== ')') exports.push(name);
            }
        } else {
            const importM = importRe.exec(line);
            if (importM) imports.push(importM[1]);
        }

        let m: RegExpExecArray | null;
        let kind: 'function' | 'class' | null = null;
        let symName = '';
        if ((m = defRe.exec(line))) { kind = 'function'; symName = m[1]; }
        else if ((m = classRe.exec(line))) { kind = 'class'; symName = m[1]; }

        if (kind && symName) {
            const baseIndent = line.length - line.trimStart().length;
            const start = i + 1;
            const end = pythonBlockEnd(lines, i, baseIndent) + 1;
            symbols.push({ name: symName, kind, start, end });
        }
    }

    return { imports: dedupe(imports), exports: dedupe(exports), symbols };
}

function extractForFile(rel: string, text: string) {
    const family = classifyPath(rel);
    if (family === 'tsjs') return extractTsJs(text);
    if (family === 'py') return extractPy(text);
    return { imports: [], exports: [], symbols: [] };
}

function resolveImport(fromRel: string, spec: string, allPaths: Set<string>): string | null {
    if (!spec.startsWith('.')) return null;
    const fromDir = path.posix.dirname(fromRel);
    const base = path.posix.normalize(path.posix.join(fromDir, spec));
    if (base.startsWith('..')) return null;

    const candidates = [
        base,
        base + '.ts', base + '.tsx', base + '.mts', base + '.cts',
        base + '.js', base + '.jsx', base + '.mjs', base + '.cjs',
        base + '.py', base + '.pyi',
        base + '.vue', base + '.svelte', base + '.astro',
        base + '/index.ts', base + '/index.tsx', base + '/index.js',
        base + '/index.jsx', base + '/index.py',
        base + '/__init__.py'
    ];
    for (const c of candidates) if (allPaths.has(c)) return c;
    return null;
}

function buildEntry(rel: string, content: string, allPaths: Set<string>): FileEntry {
    const { imports, exports, symbols } = extractForFile(rel, content);
    const resolved: string[] = [];
    for (const spec of imports) {
        const r = resolveImport(rel, spec, allPaths);
        resolved.push(r ?? spec);
    }
    return {
        path: rel,
        tokens: estimateTokens(content),
        sha1: sha1Of(content),
        imports: dedupe(resolved),
        exports: dedupe(exports),
        symbols,
        summary: null,
        tags: []
    };
}

function emptyIndex(workspaceRoot: string): IndexData {
    return { version: INDEX_VERSION, workspaceRoot, generatedAt: new Date().toISOString(), files: {} };
}

interface QueuedOp {
    op: 'update' | 'remove';
    rel: string;
    content?: string;
}

export class Indexer implements vscode.Disposable {
    private index: IndexData;
    private provider: FileContentProvider | null = null;
    private saveTimer: NodeJS.Timeout | null = null;
    private dirty = false;
    private ready = false;
    private queued: QueuedOp[] = [];

    constructor(private workspaceRoot: string) {
        this.index = emptyIndex(workspaceRoot);
    }

    get indexPath(): string {
        return path.join(this.workspaceRoot, INDEX_DIR, INDEX_FILE);
    }

    async initialize(provider: FileContentProvider): Promise<void> {
        this.provider = provider;
        const loaded = await this.loadFromDisk();
        if (loaded) this.index = loaded;
        else this.rebuildAll(provider);

        this.ready = true;
        const queued = this.queued;
        this.queued = [];
        for (const q of queued) {
            if (q.op === 'update' && q.content !== undefined) this.updateFile(q.rel, q.content);
            else this.removeFile(q.rel);
        }
    }

    private async loadFromDisk(): Promise<IndexData | null> {
        try {
            const text = await fs.promises.readFile(this.indexPath, 'utf8');
            const data = JSON.parse(text) as IndexData;
            if (!data || data.version !== INDEX_VERSION) return null;
            if (!data.files || typeof data.files !== 'object') return null;
            return data;
        } catch { return null; }
    }

    private rebuildAll(provider: FileContentProvider): void {
        const all = provider.getAllFiles();
        const allPaths = new Set(all.keys());
        const files: Record<string, FileEntry> = {};
        for (const [rel, content] of all) {
            if (isExcludedPath(rel)) continue;
            files[rel] = buildEntry(rel, content, allPaths);
        }
        this.index = {
            version: INDEX_VERSION,
            workspaceRoot: this.workspaceRoot,
            generatedAt: new Date().toISOString(),
            files
        };
        this.dirty = true;
        this.scheduleSave();
    }

    updateFile(rel: string, content: string): void {
        if (!this.ready) { this.queued.push({ op: 'update', rel, content }); return; }
        if (isExcludedPath(rel)) return;
        const allPaths = this.collectAllPaths();
        const newEntry = buildEntry(rel, content, allPaths);
        const old = this.index.files[rel];
        if (old && old.sha1 === newEntry.sha1) return;
        this.index.files[rel] = newEntry;
        this.dirty = true;
        this.scheduleSave();
    }

    removeFile(rel: string): void {
        if (!this.ready) { this.queued.push({ op: 'remove', rel }); return; }
        let changed = false;
        if (this.index.files[rel]) { delete this.index.files[rel]; changed = true; }
        const prefix = rel.endsWith('/') ? rel : rel + '/';
        for (const key of Object.keys(this.index.files)) {
            if (key.startsWith(prefix)) { delete this.index.files[key]; changed = true; }
        }
        if (changed) { this.dirty = true; this.scheduleSave(); }
    }

    /** Atualiza `summary` e `tags` de uma entrada (sem alterar conteúdo/símbolos). */
    updateFileMeta(rel: string, patch: { summary?: string | null; tags?: string[] }): void {
        const entry = this.index.files[rel];
        if (!entry) return;
        let changed = false;
        if (patch.summary !== undefined && entry.summary !== patch.summary) {
            entry.summary = patch.summary;
            changed = true;
        }
        if (patch.tags !== undefined) {
            const same = entry.tags.length === patch.tags.length
                && entry.tags.every((t, i) => t === patch.tags![i]);
            if (!same) { entry.tags = patch.tags; changed = true; }
        }
        if (changed) { this.dirty = true; this.scheduleSave(); }
    }

    private collectAllPaths(): Set<string> {
        const all = this.provider?.getAllFiles();
        if (all) return new Set(all.keys());
        return new Set(Object.keys(this.index.files));
    }

    getIndex(): IndexData { return this.index; }
    getEntry(rel: string): FileEntry | undefined { return this.index.files[rel]; }

    /** Conteúdo em memória de um arquivo (via provider). */
    getContent(rel: string): string | undefined {
        return this.provider?.getFile(rel);
    }

    getReverseImports(): Map<string, string[]> {
        const reverse = new Map<string, string[]>();
        for (const [rel, entry] of Object.entries(this.index.files)) {
            for (const imp of entry.imports) {
                const list = reverse.get(imp) || [];
                list.push(rel);
                reverse.set(imp, list);
            }
        }
        return reverse;
    }

    private scheduleSave(): void {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.flush().catch(() => { /* ignore */ });
        }, SAVE_DEBOUNCE_MS);
    }

    async flush(): Promise<void> {
        if (!this.dirty) return;
        const dir = path.dirname(this.indexPath);
        try { await fs.promises.mkdir(dir, { recursive: true }); } catch { /* ignore */ }
        const tmp = this.indexPath + '.tmp';
        try {
            this.index.generatedAt = new Date().toISOString();
            await fs.promises.writeFile(tmp, JSON.stringify(this.index, null, 2), 'utf8');
            await fs.promises.rename(tmp, this.indexPath);
            this.dirty = false;
        } catch {
            try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
        }
    }

    dispose(): void {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        if (this.dirty) {
            try {
                const dir = path.dirname(this.indexPath);
                fs.mkdirSync(dir, { recursive: true });
                const tmp = this.indexPath + '.tmp';
                this.index.generatedAt = new Date().toISOString();
                fs.writeFileSync(tmp, JSON.stringify(this.index, null, 2), 'utf8');
                fs.renameSync(tmp, this.indexPath);
                this.dirty = false;
            } catch { /* ignore */ }
        }
    }
}
