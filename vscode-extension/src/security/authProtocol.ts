/**
 * Protocolo de autenticação do navegador.
 *
 * O token NUNCA viaja na URL do WebSocket (fica no primeiro frame). A conexão
 * começa em estado "unauthenticated"; qualquer comando que não seja `auth`
 * (ou `ping`) é recusado até a autenticação acontecer.
 *
 * Fluxo:
 *   1. Servidor aceita a conexão.
 *   2. Servidor envia { type: 'auth-required' }.
 *   3. Cliente envia { type: 'auth', token: '<token>' }.
 *   4. Servidor chama onAuthenticated() ou onRejected(reason).
 *
 * Timeout: se o cliente não se autenticar dentro de authTimeoutMs (padrão 5s),
 * a conexão é rejeitada (onRejected com "timeout").
 */

export type AuthState = 'awaiting' | 'authenticated' | 'rejected';

export interface AuthProtocolOptions {
    token: string;
    /** Tempo máximo aguardando o cliente se autenticar. Padrão: 5000 ms. */
    authTimeoutMs?: number;
    onAuthenticated: () => void;
    onRejected: (reason: string) => void;
}

export class AuthProtocol {
    private state: AuthState = 'awaiting';
    private timer: NodeJS.Timeout | null = null;

    constructor(private opts: AuthProtocolOptions) {}

    start(): void {
        this.state = 'awaiting';
        const ms = this.opts.authTimeoutMs ?? 5000;
        this.timer = setTimeout(() => {
            if (this.state === 'awaiting') {
                this.state = 'rejected';
                this.opts.onRejected('timeout aguardando autenticação');
            }
        }, ms);
        if (this.timer.unref) this.timer.unref();
    }

    /**
     * Processa uma mensagem da conexão. Retorna { ok: true } se a mensagem foi
     * aceita (autenticação concluída ou já era autenticado). Em falha, devolve
     * { ok: false, error } — quem chamou decide se fecha a conexão.
     */
    handleMessage(msg: unknown): { ok: boolean; error?: string } {
        if (this.state === 'authenticated') return { ok: true };
        if (this.state === 'rejected') return { ok: false, error: 'autenticação já recusada' };

        if (!msg || typeof msg !== 'object') return { ok: false, error: 'mensagem inválida' };
        const m = msg as Record<string, unknown>;
        const type = m.type;

        if (type === 'ping') return { ok: true };

        if (type === 'auth') {
            const token = typeof m.token === 'string' ? m.token : '';
            if (token !== this.opts.token) {
                this.state = 'rejected';
                this.clearTimer();
                this.opts.onRejected('token inválido');
                return { ok: false, error: 'token inválido' };
            }
            this.state = 'authenticated';
            this.clearTimer();
            this.opts.onAuthenticated();
            return { ok: true };
        }

        return { ok: false, error: 'autenticação necessária' };
    }

    isAuthenticated(): boolean { return this.state === 'authenticated'; }
    isRejected(): boolean { return this.state === 'rejected'; }

    dispose(): void { this.clearTimer(); }

    private clearTimer(): void {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    }
}
