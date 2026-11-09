import * as fs from 'fs';
import * as path from 'path';
import {
    Decision, Knowledge, ErrorRecord, ErrorStatus, Convention, CompletedTask
} from './memoryTypes';

const DIR = '.deepseek-sync/memory';
const FILES = {
    project: 'project.md',
    architecture: 'architecture.md',
    decisions: 'decisions.md',
    knowledge: 'knowledge.json',
    errors: 'errors.json',
    conventions: 'conventions.json',
    completedTasks: 'completed-tasks.json'
} as const;

type FileKey = keyof typeof FILES;

const DEFAULT_PROJECT = '# Projeto\n\n(Descreva o objetivo, tecnologias e situação atual do projeto.)\n';
const DEFAULT_ARCHITECTURE = '# Arquitetura\n\n(Descreva a organização dos módulos, responsabilidades e fluxo de dados.)\n';
const DEFAULT_DECISIONS = '# Decisões técnicas\n\n(Registre aqui as decisões e o motivo de cada uma.)\n';

const SAVE_DEBOUNCE_MS = 1200;

function newId(prefix: string): string {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

function firstLine(s: string, max = 200): string {
    const line = (s || '').split('\n').map(l => l.trim()).find(l => l.length > 0) ?? '';
    return line.length > max ? line.slice(0, max) + '…' : line;
}

function parseDecisions(md: string): Decision[] {
    const out: Decision[] = [];
    for (const b of md.split(/^## /m).slice(1)) {
        const lines = b.split('\n');
        const title = (lines[0] || '').trim();
        if (!title) continue;
        const rest = lines.slice(1);
        const dateMatch = rest.find(l => /^_Data:\s*(.+)_$/.test(l));
        const filesMatch = rest.find(l => /^_Arquivos:\s*(.+)_$/.test(l));
        const rationale = rest
            .filter(l => !/^_Data:/.test(l) && !/^_Arquivos:/.test(l))
            .join('\n').trim();
        out.push({
            id: newId('dec'),
            title,
            rationale,
            date: dateMatch ? dateMatch.replace(/^_Data:\s*/, '').replace(/_$/, '') : '',
            relatedFiles: filesMatch
                ? filesMatch.replace(/^_Arquivos:\s*/, '').replace(/_$/, '')
                    .split(',').map(s => s.trim()).filter(Boolean)
                : []
        });
    }
    return out;
}

function serializeDecisions(items: Decision[]): string {
    const parts = [DEFAULT_DECISIONS.trim(), ''];
    for (const d of items) {
        parts.push(`## ${d.title}`, '');
        if (d.rationale) parts.push(d.rationale);
        if (d.date) parts.push(`_Data: ${d.date}_`);
        if (d.relatedFiles.length > 0) parts.push(`_Arquivos: ${d.relatedFiles.join(', ')}_`);
        parts.push('');
    }
    return parts.join('\n');
}

/**
 * Memória estruturada em `.deepseek-sync/memory/`.
 *
 * Não substitui o `state.md` — os dois coexistem. Aqui guardamos o que sobrevive
 * a várias conversas: objetivo, arquitetura, decisões, conhecimentos, erros
 * conhecidos, convenções e tarefas concluídas.
 *
 * Markdown para o que é humano (project, architecture, decisions); JSON para o
 * que é consultado por código (knowledge, errors, conventions, completedTasks).
 */
export class ProjectMemory {
    private project = DEFAULT_PROJECT;
    private architecture = DEFAULT_ARCHITECTURE;
    private decisions: Decision[] = [];
    private knowledge: Knowledge[] = [];
    private errors: ErrorRecord[] = [];
    private conventions: Convention[] = [];
    private completedTasks: CompletedTask[] = [];
    private dirty = new Set<FileKey>();
    private timer: NodeJS.Timeout | null = null;

    constructor(private workspaceRoot: string) {}

    private p(file: string): string { return path.join(this.workspaceRoot, DIR, file); }

    async load(): Promise<void> {
        await this.ensureDefaults();
        try { this.project = await fs.promises.readFile(this.p(FILES.project), 'utf8'); } catch { /* default */ }
        try { this.architecture = await fs.promises.readFile(this.p(FILES.architecture), 'utf8'); } catch { /* default */ }
        try {
            const text = await fs.promises.readFile(this.p(FILES.decisions), 'utf8');
            this.decisions = parseDecisions(text);
        } catch { /* vazio */ }
        this.knowledge = await this.readJson<Knowledge>(this.p(FILES.knowledge));
        this.errors = await this.readJson<ErrorRecord>(this.p(FILES.errors));
        this.conventions = await this.readJson<Convention>(this.p(FILES.conventions));
        this.completedTasks = await this.readJson<CompletedTask>(this.p(FILES.completedTasks));
    }

    private async ensureDefaults(): Promise<void> {
        const dir = path.join(this.workspaceRoot, DIR);
        try { await fs.promises.mkdir(dir, { recursive: true }); } catch { /* ignore */ }
        const mdDefaults: Array<[FileKey, string]> = [
            ['project', DEFAULT_PROJECT],
            ['architecture', DEFAULT_ARCHITECTURE],
            ['decisions', DEFAULT_DECISIONS]
        ];
        for (const [key, content] of mdDefaults) {
            const file = this.p(FILES[key]);
            if (!fs.existsSync(file)) {
                try { await fs.promises.writeFile(file, content, 'utf8'); } catch { /* ignore */ }
            }
        }
        const jsonDefaults: FileKey[] = ['knowledge', 'errors', 'conventions', 'completedTasks'];
        for (const key of jsonDefaults) {
            const file = this.p(FILES[key]);
            if (!fs.existsSync(file)) {
                try { await fs.promises.writeFile(file, JSON.stringify({ version: 1, items: [] }, null, 2), 'utf8'); } catch { /* ignore */ }
            }
        }
    }

    private async readJson<T>(file: string): Promise<T[]> {
        try {
            const raw = await fs.promises.readFile(file, 'utf8');
            const data = JSON.parse(raw);
            return Array.isArray(data?.items) ? data.items as T[] : [];
        } catch { return []; }
    }

    private async writeJson<T>(file: string, items: T[]): Promise<void> {
        const tmp = file + '.tmp';
        try {
            await fs.promises.writeFile(tmp, JSON.stringify({ version: 1, items }, null, 2), 'utf8');
            await fs.promises.rename(tmp, file);
        } catch { /* ignore */ }
    }

    getProject(): string { return this.project; }
    getArchitecture(): string { return this.architecture; }
    getDecisions(): Decision[] { return [...this.decisions]; }
    getErrors(): ErrorRecord[] { return [...this.errors]; }
    getKnowledge(): Knowledge[] { return [...this.knowledge]; }
    getConventions(): Convention[] { return [...this.conventions]; }
    getCompletedTasks(): CompletedTask[] { return [...this.completedTasks]; }

    async setProject(text: string): Promise<void> {
        this.project = text;
        this.markDirty('project');
    }

    async setArchitecture(text: string): Promise<void> {
        this.architecture = text;
        this.markDirty('architecture');
    }

    async addDecision(d: Omit<Decision, 'id' | 'date'>): Promise<Decision> {
        const full: Decision = { id: newId('dec'), date: new Date().toISOString(), ...d };
        this.decisions.push(full);
        this.markDirty('decisions');
        return full;
    }

    async addKnowledge(k: Omit<Knowledge, 'id' | 'createdAt'>): Promise<Knowledge> {
        const full: Knowledge = { id: newId('know'), createdAt: new Date().toISOString(), ...k };
        this.knowledge.push(full);
        this.markDirty('knowledge');
        return full;
    }

    async addError(e: Omit<ErrorRecord, 'id' | 'createdAt' | 'status'> & { status?: ErrorStatus }): Promise<ErrorRecord> {
        const full: ErrorRecord = {
            id: newId('err'),
            createdAt: new Date().toISOString(),
            status: e.status ?? 'open',
            ...e
        };
        this.errors.push(full);
        this.markDirty('errors');
        return full;
    }

    async resolveError(id: string, solution: string, verified: boolean): Promise<boolean> {
        const e = this.errors.find(x => x.id === id);
        if (!e) return false;
        e.status = 'resolved';
        e.solution = solution;
        e.verified = verified;
        e.resolvedAt = new Date().toISOString();
        this.markDirty('errors');
        return true;
    }

    async addConvention(c: Omit<Convention, 'id'>): Promise<Convention> {
        const full: Convention = { id: newId('conv'), ...c };
        this.conventions.push(full);
        this.markDirty('conventions');
        return full;
    }

    async addCompletedTask(t: Omit<CompletedTask, 'id' | 'completedAt'>): Promise<CompletedTask> {
        const full: CompletedTask = {
            id: newId('task'),
            completedAt: new Date().toISOString(),
            ...t
        };
        this.completedTasks.push(full);
        this.markDirty('completedTasks');
        return full;
    }

    /**
     * Resumo curto para incluir em prompts ou no state enviado ao navegador.
     * Prioriza erros abertos, decisões recentes e convenções.
     */
    toContextSummary(maxChars = 4000): string {
        const parts: string[] = [];
        parts.push('--- MEMÓRIA DO PROJETO ---');
        parts.push('Objetivo: ' + firstLine(this.project));
        parts.push('');

        const openErrors = this.errors.filter(e => e.status === 'open');
        if (openErrors.length > 0) {
            parts.push(`Erros abertos (${openErrors.length}):`);
            for (const e of openErrors.slice(-5)) {
                parts.push(`- ${e.message}${e.file ? ` (${e.file})` : ''}`);
            }
            parts.push('');
        }

        if (this.decisions.length > 0) {
            parts.push('Decisões recentes:');
            for (const d of this.decisions.slice(-5)) {
                parts.push(`- ${d.title}: ${firstLine(d.rationale, 140)}`);
            }
            parts.push('');
        }

        if (this.conventions.length > 0) {
            parts.push('Convenções:');
            for (const c of this.conventions.slice(0, 8)) parts.push(`- [${c.category}] ${c.rule}`);
            parts.push('');
        }

        const done = this.completedTasks.slice(-5);
        if (done.length > 0) {
            parts.push('Concluídos recentemente:');
            for (const t of done) parts.push(`- ${t.title}`);
        }

        let out = parts.join('\n').trim();
        if (out.length > maxChars) out = out.slice(0, maxChars - 40) + '\n[...memória truncada]';
        return out;
    }

    private markDirty(key: FileKey): void {
        this.dirty.add(key);
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush().catch(() => { /* ignore */ });
        }, SAVE_DEBOUNCE_MS);
    }

    async flush(): Promise<void> {
        if (this.dirty.size === 0) return;
        const toSave = [...this.dirty];
        this.dirty.clear();
        for (const key of toSave) {
            try {
                if (key === 'project') await fs.promises.writeFile(this.p(FILES.project), this.project, 'utf8');
                else if (key === 'architecture') await fs.promises.writeFile(this.p(FILES.architecture), this.architecture, 'utf8');
                else if (key === 'decisions') await fs.promises.writeFile(this.p(FILES.decisions), serializeDecisions(this.decisions), 'utf8');
                else if (key === 'knowledge') await this.writeJson(this.p(FILES.knowledge), this.knowledge);
                else if (key === 'errors') await this.writeJson(this.p(FILES.errors), this.errors);
                else if (key === 'conventions') await this.writeJson(this.p(FILES.conventions), this.conventions);
                else if (key === 'completedTasks') await this.writeJson(this.p(FILES.completedTasks), this.completedTasks);
            } catch { /* ignore */ }
        }
    }

    dispose(): void {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (this.dirty.size === 0) return;
        try {
            if (this.dirty.has('project')) fs.writeFileSync(this.p(FILES.project), this.project, 'utf8');
            if (this.dirty.has('architecture')) fs.writeFileSync(this.p(FILES.architecture), this.architecture, 'utf8');
            if (this.dirty.has('decisions')) fs.writeFileSync(this.p(FILES.decisions), serializeDecisions(this.decisions), 'utf8');
            if (this.dirty.has('knowledge')) fs.writeFileSync(this.p(FILES.knowledge), JSON.stringify({ version: 1, items: this.knowledge }, null, 2), 'utf8');
            if (this.dirty.has('errors')) fs.writeFileSync(this.p(FILES.errors), JSON.stringify({ version: 1, items: this.errors }, null, 2), 'utf8');
            if (this.dirty.has('conventions')) fs.writeFileSync(this.p(FILES.conventions), JSON.stringify({ version: 1, items: this.conventions }, null, 2), 'utf8');
            if (this.dirty.has('completedTasks')) fs.writeFileSync(this.p(FILES.completedTasks), JSON.stringify({ version: 1, items: this.completedTasks }, null, 2), 'utf8');
        } catch { /* ignore */ }
        this.dirty.clear();
    }
}
