const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export type GeminiError = 'no-key' | 'timeout' | 'rate-limit' | 'http' | 'json' | 'aborted';

export type GeminiResult<T> =
    | { ok: true; data: T }
    | { ok: false; error: GeminiError; detail?: string };

interface GenerateOptions {
    /** Instrução de sistema (opcional). */
    system?: string;
    /** Prompt do usuário. */
    prompt: string;
    /** Timeout em segundos. Padrão: 60. */
    timeoutSec?: number;
    /** AbortSignal externo para cancelamento (ex.: parar o agente). */
    signal?: AbortSignal;
    /** Se true, pede JSON no responseMimeType. Padrão: true. */
    json?: boolean;
}

interface GeminiResponse {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    error?: { code?: number; message?: string; status?: string };
}

/**
 * Cliente mínimo da API do Gemini.
 *
 * - A chave vem de `getKey()` (SecretStorage). NUNCA é logada, nem entra em URL.
 * - Usa `x-goog-api-key` no cabeçalho.
 * - Aborta por timeout via AbortController.
 * - Em 429, devolve `{ ok: false, error: 'rate-limit' }` para o chamador decidir o backoff.
 * - Em 200, valida o JSON e devolve `{ ok: true, data }`.
 */
export class GeminiClient {
    constructor(
        private getKey: () => Promise<string | undefined>,
        private getModel: () => string
    ) {}

    async callJson<T>(opts: GenerateOptions): Promise<GeminiResult<T>> {
        const key = await this.getKey();
        if (!key || key.trim().length < 10) {
            return { ok: false, error: 'no-key' };
        }
        const model = (this.getModel() || 'gemini-2.0-flash').trim();
        const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent`;

        const ctrl = new AbortController();
        const timeoutMs = Math.max(5, opts.timeoutSec ?? 60) * 1000;
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        if (opts.signal) {
            if (opts.signal.aborted) {
                clearTimeout(timer);
                return { ok: false, error: 'aborted' };
            }
            opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
        }

        const body: any = {
            contents: [
                { role: 'user', parts: [{ text: opts.prompt }] }
            ],
            generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 8192,
                responseMimeType: opts.json === false ? 'text/plain' : 'application/json'
            }
        };
        if (opts.system) {
            body.systemInstruction = { parts: [{ text: opts.system }] };
        }

        let response: Response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': key
                },
                body: JSON.stringify(body),
                signal: ctrl.signal
            });
        } catch (e) {
            clearTimeout(timer);
            if (ctrl.signal.aborted) {
                return { ok: false, error: 'timeout', detail: `tempo esgotado (${timeoutMs / 1000}s)` };
            }
            return { ok: false, error: 'http', detail: e instanceof Error ? e.message : String(e) };
        }
        clearTimeout(timer);

        if (response.status === 429) {
            const retryAfter = response.headers.get('retry-after');
            return {
                ok: false,
                error: 'rate-limit',
                detail: retryAfter ? `retry-after=${retryAfter}` : undefined
            };
        }
        if (!response.ok) {
            let detail = `HTTP ${response.status}`;
            try {
                const errBody = await response.json() as GeminiResponse;
                if (errBody.error?.message) detail += `: ${errBody.error.message}`;
            } catch { /* ignore */ }
            return { ok: false, error: 'http', detail };
        }

        let parsed: GeminiResponse;
        try {
            parsed = await response.json() as GeminiResponse;
        } catch (e) {
            return { ok: false, error: 'json', detail: 'resposta não é JSON válido' };
        }

        const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
            return { ok: false, error: 'json', detail: 'resposta sem texto do modelo' };
        }

        if (opts.json === false) {
            return { ok: true, data: text as unknown as T };
        }

        try {
            const data = JSON.parse(text) as T;
            return { ok: true, data };
        } catch {
            return { ok: false, error: 'json', detail: 'JSON do modelo inválido' };
        }
    }
}
