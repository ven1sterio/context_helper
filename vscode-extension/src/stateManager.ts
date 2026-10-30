import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

const DIR = '.deepseek-sync';
const FILE = 'state.md';
const MAX_LIST = 20;
const MAX_TOUCHED = 40;

/**
 * Campos que o código escreve automaticamente em `.deepseek-sync/state.md`.
 * `decisions` e `rollbacks` são mantidos pelo usuário (o código não toca neles
 * se o patch não os incluir — preserva o que você digitou).
 */
export interface StateUpdate {
    objective?: string;
    plan?: string[];
    working?: string[];
    broken?: string[];
    decisions?: string[];
    rollbacks?: string[];
    lastFailure?: string;
    touched?: string[];
}

interface StoredState {
    objective: string;
    plan: string[];
    working: string[];
    broken: string[];
    decisions: string[];
    rollbacks: string[];
    lastFailure: string;
    touched: string[];
    updatedAt: string;
}

function emptyState(): StoredState {
    return {
        objective: '',
        plan: [],
        working: [],
        broken: [],
        decisions: [],
        rollbacks: [],
        lastFailure: '',
        touched: [],
        updatedAt: new Date().toISOString()
    };
}

function parseList(buf: string): string[] {
    return buf
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('-'))
        .map(l => l.slice(1).trim())
        .filter(l => l.length > 0);
}

/**
 * Persiste um resumo curto do estado do projeto em `.deepseek-sync/state.md`.
 *
 * O arquivo segue o esqueleto:
 *   # Estado do projeto
 *   ## Objetivo        (automático)
 *   ## Plano           (manual / agente)
 *   ## Funciona        (automático)
 *   ## Quebrado        (automático)
 *   ## Decisões        (manual — preservado)
 *   ## Rollbacks       (manual — preservado)
 *   ## Última falha    (automático)
 *   ## Arquivos tocados (automático)
 *
 * Preserva conteúdo manual dos cabeçalhos existentes ao recarregar. Gravação
 * atômica (tmp + rename), com debounce de 1 s.
 */
export class StateManager implements vscode.Disposable {
    private state: StoredState = emptyState();
    private dirty = false;
    private saveTimer: NodeJS.Timeout | null = null;

    constructor(private workspaceRoot: string) {}

    get filePath(): string {
        return path.join(this.workspaceRoot, DIR, FILE);
    }

    async initialize(): Promise<void> {
        try {
            const text = await fs.promises.readFile(this.filePath, 'utf8');
            const parsed = this.parse(text);
            if (parsed) this.state = parsed;
        } catch { /* inexistente: começa vazio */ }
    }

    private parse(text: string): StoredState {
        const lines = text.replace(/\r\n/g, '\n').split('\n');
        const state = emptyState();
        let section = '';
        let buf: string[] = [];

        const flush = () => {
            const joined = buf.join('\n').trim();
            switch (section) {
                case 'objetivo':
                    state.objective = joined;
                    break;
                case 'plano':
                    state.plan = parseList(joined);
                    break;
                case 'funciona':
                    state.working = parseList(joined);
                    break;
                case 'quebrado':
                    state.broken = parseList(joined);
                    break;
                case 'decisões':
                case 'decisoes':
                    state.decisions = parseList(joined);
                    break;
                case 'rollbacks':
                    state.rollbacks = parseList(joined);
                    break;
                case 'última falha':
                case 'ultima falha':
                    state.lastFailure = joined;
                    break;
                case 'arquivos tocados':
                    state.touched = parseList(joined);
                    break;
            }
            buf = [];
        };

        for (const line of lines) {
            const h = /^##\s+(.+)$/.exec(line);
            if (h) {
                flush();
                section = h[1].trim().toLowerCase();
                continue;
            }
            // Ignora o "# Estado do projeto" e o "_Atualizado em …_".
            if (/^#\s+/.test(line)) continue;
            if (/^_.*_$/.test(line.trim())) continue;
            buf.push(line);
        }
        flush();
        return state;
    }

    update(patch: StateUpdate): void {
        if (patch.objective !== undefined) {
            this.state.objective = patch.objective.slice(0, 2000);
        }
        if (patch.plan !== undefined) {
            this.state.plan = patch.plan.slice(0, MAX_LIST);
        }
        if (patch.working !== undefined) {
            this.state.working = patch.working.slice(0, MAX_LIST);
        }
        if (patch.broken !== undefined) {
            this.state.broken = patch.broken.slice(0, MAX_LIST);
        }
        if (patch.decisions !== undefined) {
            this.state.decisions = patch.decisions.slice(0, MAX_LIST);
        }
        if (patch.rollbacks !== undefined) {
            this.state.rollbacks = patch.rollbacks.slice(0, MAX_LIST);
        }
        if (patch.lastFailure !== undefined) {
            this.state.lastFailure = patch.lastFailure.slice(0, 4000);
        }
        if (patch.touched !== undefined) {
            this.state.touched = [...new Set([...patch.touched, ...this.state.touched])]
                .slice(0, MAX_TOUCHED);
        }
        this.state.updatedAt = new Date().toISOString();
        this.dirty = true;
        this.scheduleSave();
    }

    /** Markdown com todos os cabeçalhos do esqueleto (mesmo quando vazios). */
    toMarkdown(): string {
        const s = this.state;
        const parts: string[] = [];
        parts.push('# Estado do projeto');
        parts.push('');
        parts.push(`_Atualizado em ${s.updatedAt}_`);
        parts.push('');

        parts.push('## Objetivo');
        parts.push(s.objective || '(não definido)');
        parts.push('');

        parts.push('## Plano');
        if (s.plan.length > 0) for (const p of s.plan) parts.push(`- ${p}`);
        else parts.push('(vazio)');
        parts.push('');

        parts.push('## Funciona');
        if (s.working.length > 0) for (const w of s.working) parts.push(`- ${w}`);
        else parts.push('(vazio)');
        parts.push('');

        parts.push('## Quebrado');
        if (s.broken.length > 0) for (const b of s.broken) parts.push(`- ${b}`);
        else parts.push('(vazio)');
        parts.push('');

        parts.push('## Decisões');
        if (s.decisions.length > 0) for (const d of s.decisions) parts.push(`- ${d}`);
        else parts.push('(vazio)');
        parts.push('');

        parts.push('## Rollbacks');
        if (s.rollbacks.length > 0) for (const r of s.rollbacks) parts.push(`- ${r}`);
        else parts.push('(vazio)');
        parts.push('');

        parts.push('## Última falha');
        parts.push(s.lastFailure || '(nenhuma)');
        parts.push('');

        parts.push('## Arquivos tocados');
        if (s.touched.length > 0) for (const t of s.touched) parts.push(`- ${t}`);
        else parts.push('(vazio)');
        parts.push('');

        return parts.join('\n').trim() + '\n';
    }

    private scheduleSave(): void {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.flush().catch(() => { /* ignore */ });
        }, 1000);
    }

    async flush(): Promise<void> {
        if (!this.dirty) return;
        const dir = path.dirname(this.filePath);
        try { await fs.promises.mkdir(dir, { recursive: true }); } catch { /* ignore */ }
        try {
            const tmp = this.filePath + '.tmp';
            await fs.promises.writeFile(tmp, this.toMarkdown(), 'utf8');
            await fs.promises.rename(tmp, this.filePath);
            this.dirty = false;
        } catch { /* ignore */ }
    }

    dispose(): void {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        if (this.dirty) {
            try {
                const dir = path.dirname(this.filePath);
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(this.filePath, this.toMarkdown(), 'utf8');
                this.dirty = false;
            } catch { /* ignore */ }
        }
    }
}
