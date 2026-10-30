import * as vscode from 'vscode';

const STATE_KEY = 'deepseekContextSync.geminiQuota';
const MIN_INTERVAL_MS = 4000;      // ~15 req/min — conservador para o plano gratuito
const MAX_RETRY_ATTEMPTS = 4;

interface QuotaState {
    /** Data no fuso Pacífico (`YYYY-MM-DD`). */
    date: string;
    /** Requisições feitas hoje (0-based count). */
    count: number;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Data no fuso Pacífico (America/Los_Angeles), formato YYYY-MM-DD. */
export function pacificDateKey(d = new Date()): string {
    try {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Los_Angeles',
            year: 'numeric', month: '2-digit', day: '2-digit'
        }).formatToParts(d);
        const map: Record<string, string> = {};
        for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;
        return `${map.year}-${map.month}-${map.day}`;
    } catch {
        // Fallback: usa UTC (mais grosseiro, mas não trava)
        return d.toISOString().slice(0, 10);
    }
}

/**
 * Limitador de cota do Gemini.
 *
 * - Intervalo mínimo entre chamadas (MIN_INTERVAL_MS): evita o limite por minuto.
 * - Contador diário persistido em globalState, zerando à meia-noite do Pacífico.
 * - Aviso aos 80%, bloqueio aos 100%.
 * - 429: espera exponencial (2, 4, 8, 16 s), respeitando Retry-After quando presente.
 *
 * Observação: os limites reais do plano gratuito variam por modelo e mudam
 * com frequência. Ajuste `geminiDailyBudget` e `MIN_INTERVAL_MS` se necessário.
 */
export class QuotaManager {
    private state: QuotaState;
    private lastCallAt = 0;

    constructor(
        private store: vscode.Memento,
        private getDailyBudget: () => number,
        private warn: (msg: string) => void = () => { /* no-op */ }
    ) {
        const saved = this.store.get<QuotaState>(STATE_KEY);
        const today = pacificDateKey();
        if (saved && saved.date === today && typeof saved.count === 'number') {
            this.state = saved;
        } else {
            this.state = { date: today, count: 0 };
        }
    }

    private rolloverIfNeeded(): void {
        const today = pacificDateKey();
        if (this.state.date !== today) {
            this.state = { date: today, count: 0 };
            void this.store.update(STATE_KEY, this.state);
        }
    }

    private async persist(): Promise<void> {
        try { await this.store.update(STATE_KEY, this.state); } catch { /* ignore */ }
    }

    private get limit(): number {
        const v = this.getDailyBudget();
        return Number.isFinite(v) && v > 0 ? Math.floor(v) : 200;
    }

    /** Diagnóstico: quantas chamadas já foram feitas hoje e qual o limite. */
    getStatus(): { date: string; used: number; limit: number; remaining: number } {
        this.rolloverIfNeeded();
        const limit = this.limit;
        return {
            date: this.state.date,
            used: this.state.count,
            limit,
            remaining: Math.max(0, limit - this.state.count)
        };
    }

    /** True se ainda há cota diária e já passou o intervalo mínimo desde a última chamada. */
    canCallNow(): boolean {
        this.rolloverIfNeeded();
        if (this.state.count >= this.limit) return false;
        return Date.now() - this.lastCallAt >= MIN_INTERVAL_MS;
    }

    /**
     * Adquire uma "vaga" para uma chamada. Se a cota diária estourou, retorna false
     * sem esperar. Se só o intervalo mínimo ainda não passou, espera (até alguns segundos).
     * Retorna true quando pode chamar.
     */
    async acquire(): Promise<boolean> {
        this.rolloverIfNeeded();
        if (this.state.count >= this.limit) return false;

        const sinceLast = Date.now() - this.lastCallAt;
        if (sinceLast < MIN_INTERVAL_MS) {
            const wait = MIN_INTERVAL_MS - sinceLast;
            if (wait > 60000) return false; // não esperamos mais do que isso
            await sleep(wait);
        }

        // Re-checa após a espera (a data pode ter virado / outra aba pode ter consumido)
        this.rolloverIfNeeded();
        if (this.state.count >= this.limit) return false;

        this.lastCallAt = Date.now();
        this.state.count++;
        await this.persist();

        const limit = this.limit;
        if (this.state.count === Math.ceil(limit * 0.8)) {
            this.warn(`⚠️ Gemini: ${this.state.count}/${limit} requisições usadas hoje (80%).`);
        } else if (this.state.count === limit) {
            this.warn(`⛔ Gemini: cota diária atingida (${limit}). Voltamos ao seletor local até amanhã (horário do Pacífico).`);
        }
        return true;
    }

    /**
     * Trata um 429 (rate limit). Aplica espera exponencial (2, 4, 8, 16 s) e
     * respeita `Retry-After` quando o servidor informa. Devolve true se, ao final,
     * ainda faz sentido tentar de novo (a cota global diária não estourou).
     */
    async backoff(retryAfterSec?: number): Promise<boolean> {
        for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
            const waitSec = retryAfterSec ?? Math.pow(2, attempt + 1);
            await sleep(waitSec * 1000);
            if (this.getStatus().remaining > 0) return true;
        }
        return false;
    }
}
