import * as vscode from 'vscode';

export interface Timeouts {
    /** Tempo máximo aguardando a resposta do chat (segundos). */
    response: number;
    /** Tempo máximo de um comando de build/teste (segundos). */
    run: number;
    /** Tempo máximo de uma chamada à API do Gemini (segundos). */
    gemini: number;
    /** Tempo máximo aguardando o VS Code aplicar+rodar no navegador (segundos). */
    apply: number;
}

export const ALLOWED_TIMEOUTS: ReadonlyArray<number> = [60, 300, 600];

const DEFAULT_RESPONSE = 600;
const DEFAULT_RUN = 600;
const DEFAULT_GEMINI = 60;
const APPLY_OVERHEAD = 180;

/** Valor EXPLICITAMENTE configurado pelo usuário (global/workspace/folder). */
function getExplicit(cfg: vscode.WorkspaceConfiguration, key: string): unknown {
    const info = cfg.inspect(key);
    if (!info) return undefined;
    return info.globalValue ?? info.workspaceValue ?? info.workspaceFolderValue;
}

function clamp(seconds: unknown, fallback: number): number {
    if (typeof seconds !== 'number' || !isFinite(seconds) || seconds <= 0) return fallback;
    if (seconds < 60) return 60;
    if (seconds > 3600) return 3600;
    return Math.round(seconds);
}

/**
 * Lê as três configurações de timeout + o derivado `apply`.
 *
 * Compatibilidade: se o usuário definiu `runTimeoutSec` (nome antigo) e NÃO
 * definiu `runTimeout` (nome novo), usa o antigo. Caso contrário, usa o novo.
 */
export function getTimeouts(): Timeouts {
    const cfg = vscode.workspace.getConfiguration('deepseekContextSync');

    const response = clamp(
        getExplicit(cfg, 'responseTimeout'),
        DEFAULT_RESPONSE
    );

    const gemini = clamp(
        getExplicit(cfg, 'geminiTimeout'),
        DEFAULT_GEMINI
    );

    let run: number;
    const explicitRun = getExplicit(cfg, 'runTimeout');
    if (explicitRun !== undefined) {
        run = clamp(explicitRun, DEFAULT_RUN);
    } else {
        const legacy = getExplicit(cfg, 'runTimeoutSec');
        run = legacy !== undefined ? clamp(legacy, DEFAULT_RUN) : DEFAULT_RUN;
    }

    return {
        response,
        run,
        gemini,
        apply: run + APPLY_OVERHEAD
    };
}

/** Payload no formato que o navegador espera na mensagem `config`. */
export function timeoutsPayload(): { response: number; run: number; apply: number; gemini: number } {
    const t = getTimeouts();
    return { response: t.response, run: t.run, apply: t.apply, gemini: t.gemini };
}
