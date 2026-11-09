import { IndexData } from '../indexer';

export interface FileBudget {
    path: string;
    tokens: number;
    priority: number;
    reason: string;
}

export interface BudgetResult {
    ordered: FileBudget[];
    totalTokens: number;
    omitted: string[];
}

interface BudgetOptions {
    skeletonReserve?: number;
    minPerFile?: number;
}

/**
 * Ordena arquivos por importância para o contexto, sob um orçamento de tokens.
 *
 * Prioridade:
 *   100 — entry points (index, main, app, extension, server, content, background)
 *    90 — configs (package.json, tsconfig, pyproject, manifest...)
 *    80 — README / docs de visão geral
 *    70 — build/infra (Dockerfile, Makefile...)
 *    50 — demais
 *    30 — testes
 *
 * Arquivos que não cabem vão em `omitted`. `mustInclude` força a entrada mesmo
 * que o budget seja apertado (usado pelo seletivo para seeds do grafo).
 */
export class ContextBudget {
    constructor(private index: IndexData) {}

    compute(maxTokens: number, mustInclude: string[] = [], opts: BudgetOptions = {}): BudgetResult {
        const tokens = Math.max(2000, maxTokens);
        const reserve = opts.skeletonReserve ?? 0.10;
        const available = Math.floor(tokens * (1 - reserve));
        const minPerFile = opts.minPerFile ?? 500;

        const entries = Object.entries(this.index.files).map(([rel, e]) => ({
            path: rel,
            tokens: e.tokens,
            priority: this.priorityOf(rel)
        }));

        const must = new Set(mustInclude);
        entries.sort((a, b) => {
            const am = must.has(a.path) ? 1 : 0;
            const bm = must.has(b.path) ? 1 : 0;
            if (am !== bm) return bm - am;
            if (b.priority !== a.priority) return b.priority - a.priority;
            return a.tokens - b.tokens;
        });

        const ordered: FileBudget[] = [];
        const omitted: string[] = [];
        let used = 0;
        for (const f of entries) {
            if (f.tokens < minPerFile) {
                if (used + f.tokens <= available) {
                    ordered.push({ path: f.path, tokens: f.tokens, priority: f.priority, reason: 'pequeno' });
                    used += f.tokens;
                } else {
                    omitted.push(f.path);
                }
                continue;
            }
            if (used + f.tokens > available) {
                omitted.push(f.path);
                continue;
            }
            ordered.push({
                path: f.path,
                tokens: f.tokens,
                priority: f.priority,
                reason: this.reasonOf(f.priority)
            });
            used += f.tokens;
        }

        return { ordered, totalTokens: used, omitted };
    }

    private priorityOf(rel: string): number {
        const base = (rel.split('/').pop() ?? rel).toLowerCase();
        if (/^(index|main|app|extension|server|content|background)\.[a-z]+$/.test(base)) return 100;
        if (/^(package\.json|tsconfig\.json|pyproject\.toml|requirements\.txt|cargo\.toml|go\.mod|manifest\.json|setup\.py)$/.test(base)) return 90;
        if (/^readme/.test(base)) return 80;
        if (/^(dockerfile|makefile|gemfile|procfile)$/.test(base)) return 70;
        if (/(^|\/)test\//.test(rel) || /\.test\.[a-z]+$/.test(rel)) return 30;
        return 50;
    }

    private reasonOf(priority: number): string {
        if (priority === 100) return 'entry point';
        if (priority === 90) return 'config';
        if (priority === 80) return 'visão geral';
        if (priority === 70) return 'build/infra';
        if (priority === 30) return 'teste';
        return 'relevante';
    }
}
