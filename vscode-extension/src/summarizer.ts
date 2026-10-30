import * as vscode from 'vscode';
import { Indexer } from './indexer';
import { GeminiClient } from './geminiClient';
import { QuotaManager } from './quota';
import { isSensitiveForGemini } from './pathRules';

const MAX_BATCH_TOKENS = 30_000;
const MAX_FILE_CHARS = 8_000;
const DEBOUNCE_MS = 3000;
const MIN_FILES_BEFORE_START = 1;

const FIXED_TAXONOMY = [
    'ui', 'api', 'database', 'auth', 'config', 'build', 'test', 'docs',
    'log', 'util', 'model', 'view', 'controller', 'service', 'hook',
    'middleware', 'router', 'static', 'style', 'script', 'entry', 'cli'
];

interface SummaryItem {
    path: string;
    summary: string;
    tags: string[];
}

interface SummaryResponse {
    files?: SummaryItem[];
}

/**
 * Sumarizador incremental.
 *
 * - Só considera arquivos NÃO sensíveis para o Gemini (`isSensitiveForGemini`).
 * - Pula arquivos cujo `summary` já está preenchido no índice.
 * - Agrupa em lotes de ~30k tokens, com conteúdo truncado por arquivo (8k chars).
 * - Se o Gemini falhar (sem chave, 429, timeout, JSON inválido), para e tenta
 *   de novo no próximo gatilho; NÃO derruba o fluxo principal.
 * - Nunca envia código de arquivos sensíveis, mesmo com `allowSensitiveFiles = true`.
 *
 * `dispose()` cancela o `debounceTimer` e aborta o ciclo em andamento — sem isso,
 * o timer poderia disparar depois que a extensão foi desativada.
 */
export class Summarizer implements vscode.Disposable {
    private running = false;
    private debounceTimer: NodeJS.Timeout | null = null;
    private pendingTrigger = false;
    private abort: AbortController | null = null;

    constructor(
        private indexer: Indexer,
        private client: GeminiClient,
        private quota: QuotaManager,
        private getEnabled: () => boolean,
        private getTimeoutSec: () => number,
        private warn: (msg: string) => void = () => { /* no-op */ }
    ) {}

    /** Agenda um ciclo (debounced). Chamado quando o índice muda ou sob demanda. */
    schedule(): void {
        if (!this.getEnabled()) return;
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            void this.run();
        }, DEBOUNCE_MS);
    }

    /** Cancela tudo (usado pelo "Parar" e pelo dispose). */
    cancel(): void {
        if (this.abort) {
            try { this.abort.abort(); } catch { /* ignore */ }
            this.abort = null;
        }
    }

    dispose(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        this.cancel();
    }

    /** Executa um ciclo até esgotar (ou até falhar). */
    async run(): Promise<void> {
        if (!this.getEnabled()) return;
        if (this.running) { this.pendingTrigger = true; return; }
        this.running = true;
        this.abort = new AbortController();
        try {
            while (true) {
                if (this.abort?.signal.aborted) return;
                const pending = this.collectPending();
                if (pending.length < MIN_FILES_BEFORE_START) return;

                const batch = this.takeBatch(pending);
                if (batch.length === 0) return;

                const items = this.buildBatchPayload(batch);
                if (items.length === 0) {
                    // Todos filtrados (sensíveis); marca como done para não repetir
                    for (const rel of batch) {
                        this.indexer.updateFileMeta(rel, { summary: '(sensível — não enviado ao Gemini)', tags: [] });
                    }
                    continue;
                }

                if (!this.quota.canCallNow()) {
                    const ok = await this.quota.acquire();
                    if (!ok) {
                        this.warn('⛔ Gemini sem cota (ou intervalo mínimo). Sumarização pausada.');
                        return;
                    }
                } else {
                    await this.quota.acquire();
                }

                const res = await this.client.callJson<SummaryResponse>({
                    system:
                        'Você resume arquivos de um projeto de software. ' +
                        'Responda APENAS JSON no formato: {"files":[{"path":"...","summary":"...","tags":["..."]}]}. ' +
                        'Cada "summary" deve ter no máximo 1 linha (~120 caracteres). ' +
                        'Cada arquivo deve ter de 2 a 5 "tags" escolhidas desta taxonomia: ' +
                        FIXED_TAXONOMY.join(', ') + '. ' +
                        'Não inclua explicação fora do JSON.',
                    prompt: this.buildPrompt(items),
                    timeoutSec: this.getTimeoutSec(),
                    signal: this.abort.signal
                });

                if (!res.ok) {
                    if (res.error === 'rate-limit') {
                        const canRetry = await this.quota.backoff();
                        if (!canRetry) {
                            this.warn('⛔ Gemini: rate-limit persistente. Sumarização pausada.');
                            return;
                        }
                        continue; // tenta o mesmo lote de novo
                    }
                    if (res.error === 'aborted') return;
                    this.warn(`⚠️ Gemini (${res.error}): ${res.detail ?? ''}`.trim());
                    return;
                }

                this.applySummaries(res.data, batch);
            }
        } finally {
            this.running = false;
            this.abort = null;
            if (this.pendingTrigger) {
                this.pendingTrigger = false;
                this.schedule();
            }
        }
    }

    private collectPending(): string[] {
        const idx = this.indexer.getIndex();
        const pending: string[] = [];
        for (const [rel, entry] of Object.entries(idx.files)) {
            if (entry.summary !== null) continue;
            if (isSensitiveForGemini(rel.split('/').pop() ?? rel)) continue;
            pending.push(rel);
        }
        return pending.sort((a, b) => {
            const ta = idx.files[a]?.tokens ?? 0;
            const tb = idx.files[b]?.tokens ?? 0;
            return ta - tb;
        });
    }

    private takeBatch(pending: string[]): string[] {
        const idx = this.indexer.getIndex();
        const batch: string[] = [];
        let total = 0;
        for (const rel of pending) {
            const entry = idx.files[rel];
            if (!entry) continue;
            if (batch.length > 0 && total + entry.tokens > MAX_BATCH_TOKENS) break;
            batch.push(rel);
            total += entry.tokens;
        }
        return batch;
    }

    private buildBatchPayload(rels: string[]): Array<{ path: string; content: string }> {
        const out: Array<{ path: string; content: string }> = [];
        for (const rel of rels) {
            const name = rel.split('/').pop() ?? rel;
            if (isSensitiveForGemini(name)) continue;
            const content = this.indexer.getContent(rel);
            if (!content) continue;
            const trimmed = content.length > MAX_FILE_CHARS
                ? content.slice(0, MAX_FILE_CHARS) + `\n// ... (${content.length - MAX_FILE_CHARS} chars omitidos)`
                : content;
            out.push({ path: rel, content: trimmed });
        }
        return out;
    }

    private buildPrompt(items: Array<{ path: string; content: string }>): string {
        const parts: string[] = [];
        parts.push('Resuma cada arquivo abaixo. Devolva apenas JSON com a chave "files".');
        parts.push('');
        for (const it of items) {
            parts.push(`### ${it.path}`);
            parts.push('```');
            parts.push(it.content);
            parts.push('```');
            parts.push('');
        }
        return parts.join('\n');
    }

    private applySummaries(data: SummaryResponse, batch: string[]): void {
        const wanted = new Set(batch);
        const applied = new Set<string>();
        if (data && Array.isArray(data.files)) {
            for (const item of data.files) {
                if (!item || typeof item.path !== 'string') continue;
                if (!wanted.has(item.path)) continue; // ignora caminhos inventados
                const summary = typeof item.summary === 'string' ? item.summary.trim().slice(0, 200) : '';
                let tags = Array.isArray(item.tags)
                    ? item.tags.filter(t => typeof t === 'string').map(t => t.toLowerCase().trim()).slice(0, 5)
                    : [];
                tags = [...new Set(tags)].filter(t => FIXED_TAXONOMY.includes(t));
                if (summary) {
                    this.indexer.updateFileMeta(item.path, { summary, tags });
                    applied.add(item.path);
                }
            }
        }
        // Marca como "processado" o que o modelo esqueceu, para não travar em loop.
        for (const rel of batch) {
            if (!applied.has(rel)) {
                this.indexer.updateFileMeta(rel, { summary: '(sem resumo)', tags: [] });
            }
        }
    }
}
