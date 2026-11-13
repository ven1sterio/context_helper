/**
 * Validação das mensagens recebidas pelo WebSocket.
 *
 * Cada tipo tem campos obrigatórios, tipos e limites de tamanho. Mensagens
 * inválidas são recusadas ANTES de chegar em applyPlan/applyManager/selector.
 *
 * A validação aqui é puramente estrutural (forma e limites). A resolução de
 * caminho é feita em security/pathValidator.ts; a checagem de nomes sensíveis
 * fica em pathRules.ts.
 */

export const MAX_FILES_PER_APPLY = 80;
export const MAX_ITEM_CHARS = 500_000;
export const MAX_PATHS_PER_SELECTION = 200;
export const MAX_STATE_TEXT = 50_000;
export const MAX_QUESTION = 20_000;

const MAX_STATE_LIST_ITEMS = 40;
const MAX_STATE_ITEM_CHARS = 500;
const MAX_FILEPATH_CHARS = 1024;

export type ValidatedMessage =
    | { type: 'ping' }
    | { type: 'abort' }
    | { type: 'getState' }
    | { type: 'request'; mode: string }
    | {
        type: 'applyFiles';
        files: unknown[];
        autoApply: boolean;
        runAfter: boolean;
        missionId?: string;
        runId?: string;
        modelStatus: 'continue' | 'done' | null;
        taskId?: string;
        role?: string;
        summary?: string;
    }
    | { type: 'selectContext'; request: string }
    | { type: 'buildSelection'; paths: string[] }
    | { type: 'setTimeout'; which: string; value: number }
    | { type: 'updateState'; patch: Record<string, unknown> }
    | { type: 'startMission'; title: string; objective: string }
    | { type: 'cancelRun'; reason: string }
    | { type: 'getRun' }
    | { type: 'startMultiAgentMission'; title: string; objective: string }
    | { type: 'dispatchNextTask' }
    | { type: 'submitDeliverable'; taskId: string; summary: string; knownIssues: string[]; buildPassed: boolean; files: string[] }
    | { type: 'cancelMultiAgentMission'; reason: string }
    | { type: 'getMultiAgentState' }
    | { type: 'registerSession'; sessionId: string; provider: string }
    | { type: 'markSessionUnavailable'; sessionId: string }
    | { type: 'reRequest'; requests: ReRequestMessage[] };

export interface ReRequestMessage {
    op: string;
    file: string;
    args: string[];
    opts: Record<string, string>;
}

const RE_OPS = new Set(['info', 'functions', 'decompile', 'disasm', 'xrefs', 'strings', 'asm', 'patch']);
const MAX_RE_REQUESTS = 8;
const MAX_RE_FIELD = 2000;

export type ValidationResult =
    | { ok: true; message: ValidatedMessage }
    | { ok: false; error: string };

const fail = (error: string): ValidationResult => ({ ok: false, error });

const isString = (v: unknown): v is string => typeof v === 'string';

function checkStringArray(v: unknown, max: number, maxChars: number): string[] | null {
    if (!Array.isArray(v)) return null;
    if (v.length > max) return null;
    const out: string[] = [];
    for (const item of v) {
        if (!isString(item) || item.length > maxChars) return null;
        out.push(item);
    }
    return out;
}

function validateApplyItem(item: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
    if (!item || typeof item !== 'object') return { ok: false, error: 'item inválido' };
    const it = item as Record<string, unknown>;
    if (!isString(it.filePath) || it.filePath.length === 0 || it.filePath.length > MAX_FILEPATH_CHARS) {
        return { ok: false, error: 'filePath inválido' };
    }
    if (it.delete === true) {
        // DELETE — só o caminho. Corpo é ignorado.
        return { ok: true, value: { filePath: it.filePath, delete: true } };
    }
    if (isString(it.moveFrom) && it.moveFrom.length > 0) {
        // MOVE — filePath é o destino, moveFrom é a origem.
        if (it.moveFrom.length > MAX_FILEPATH_CHARS) {
            return { ok: false, error: `moveFrom grande demais em ${it.filePath}` };
        }
        return { ok: true, value: { filePath: it.filePath, moveFrom: it.moveFrom } };
    }
    if (it.replaceLines !== undefined && it.replaceLines !== null) {
        // REPLACE_LINES — precisa de range { start, end } e conteúdo.
        if (typeof it.replaceLines !== 'object') {
            return { ok: false, error: `replaceLines inválido em ${it.filePath}` };
        }
        const rl = it.replaceLines as Record<string, unknown>;
        const start = Number(rl.start);
        const end = Number(rl.end);
        if (!Number.isInteger(start) || !Number.isInteger(end)) {
            return { ok: false, error: `replaceLines.start/end não são inteiros em ${it.filePath}` };
        }
        if (start < 1 || end < start || end > 10_000_000) {
            return { ok: false, error: `replaceLines fora do permitido em ${it.filePath}` };
        }
        if (!isString(it.content)) return { ok: false, error: `conteúdo ausente em ${it.filePath}` };
        if (it.content.length > MAX_ITEM_CHARS) {
            return { ok: false, error: `conteúdo grande demais em ${it.filePath}` };
        }
        return { ok: true, value: { filePath: it.filePath, replaceLines: { start, end }, content: it.content } };
    }
    if (it.isEdit) {
        if (!isString(it.search)) return { ok: false, error: `SEARCH ausente em ${it.filePath}` };
        if (!isString(it.replace)) return { ok: false, error: `REPLACE ausente em ${it.filePath}` };
        if (it.search.length > MAX_ITEM_CHARS) return { ok: false, error: `SEARCH grande demais em ${it.filePath}` };
        if (it.replace.length > MAX_ITEM_CHARS) return { ok: false, error: `REPLACE grande demais em ${it.filePath}` };
        return {
            ok: true,
            value: {
                filePath: it.filePath,
                isEdit: true,
                search: it.search,
                replace: it.replace,
                unfenced: it.unfenced === true
            }
        };
    }
    if (!isString(it.content)) return { ok: false, error: `conteúdo ausente em ${it.filePath}` };
    if (it.content.length > MAX_ITEM_CHARS) return { ok: false, error: `conteúdo grande demais em ${it.filePath}` };
    return { ok: true, value: { filePath: it.filePath, content: it.content } };
}

export function validateMessage(raw: unknown): ValidationResult {
    if (!raw || typeof raw !== 'object') return fail('mensagem não é objeto');
    const m = raw as Record<string, unknown>;
    const type = m.type;
    if (!isString(type)) return fail('mensagem sem "type"');

    switch (type) {
        case 'ping':
            return { ok: true, message: { type: 'ping' } };
        case 'abort':
            return { ok: true, message: { type: 'abort' } };
        case 'getState':
            return { ok: true, message: { type: 'getState' } };

        case 'request': {
            const mode = isString(m.mode) ? m.mode : '';
            if (mode.length > 32) return fail('modo inválido');
            return { ok: true, message: { type: 'request', mode } };
        }

        case 'applyFiles': {
            if (!Array.isArray(m.files)) return fail('applyFiles: "files" ausente');
            if (m.files.length > MAX_FILES_PER_APPLY * 4) {
                return fail(`applyFiles: operações demais (máximo ${MAX_FILES_PER_APPLY * 4})`);
            }
            const files: unknown[] = [];
            for (const item of m.files) {
                const r = validateApplyItem(item);
                if (!r.ok) return fail(`applyFiles: ${r.error}`);
                files.push(r.value);
            }
            const missionId = isString(m.missionId) && m.missionId.length <= 200 ? m.missionId : undefined;
            const runId = isString(m.runId) && m.runId.length <= 200 ? m.runId : undefined;
            const modelStatus = (m.modelStatus === 'continue' || m.modelStatus === 'done') ? m.modelStatus : null;
            const taskId = isString(m.taskId) && m.taskId.length <= 200 ? m.taskId : undefined;
            const role = isString(m.role) && m.role.length <= 40 ? m.role : undefined;
            const summary = isString(m.summary) ? m.summary.slice(0, 8000) : undefined;
            return {
                ok: true,
                message: {
                    type: 'applyFiles',
                    files,
                    autoApply: !!m.autoApply,
                    runAfter: !!m.runAfter,
                    missionId,
                    runId,
                    modelStatus,
                    taskId,
                    role,
                    summary
                }
            };
        }

        case 'selectContext': {
            if (!isString(m.request)) return fail('selectContext: "request" ausente');
            if (m.request.length > MAX_QUESTION) return fail('selectContext: pedido grande demais');
            return { ok: true, message: { type: 'selectContext', request: m.request } };
        }

        case 'buildSelection': {
            if (!Array.isArray(m.paths)) return fail('buildSelection: "paths" ausente');
            if (m.paths.length > MAX_PATHS_PER_SELECTION) return fail('buildSelection: arquivos demais');
            const paths: string[] = [];
            for (const p of m.paths) {
                if (!isString(p) || p.length === 0 || p.length > MAX_FILEPATH_CHARS) {
                    return fail('buildSelection: path inválido');
                }
                paths.push(p);
            }
            return { ok: true, message: { type: 'buildSelection', paths } };
        }

        case 'setTimeout': {
            const which = isString(m.which) ? m.which : '';
            const value = Number(m.value);
            if (!['response', 'run', 'agent', 'all'].includes(which)) {
                return fail(`setTimeout: "which" inválido: ${which}`);
            }
            if (!Number.isFinite(value) || value <= 0 || value > 3600) {
                return fail('setTimeout: valor inválido');
            }
            return { ok: true, message: { type: 'setTimeout', which, value } };
        }

        case 'updateState': {
            const rawPatch = m.patch;
            if (!rawPatch || typeof rawPatch !== 'object') return fail('updateState: "patch" ausente');
            const p = rawPatch as Record<string, unknown>;
            const patch: Record<string, unknown> = {};
            if (isString(p.objective)) {
                if (p.objective.length > MAX_STATE_TEXT) return fail('updateState: objective grande demais');
                patch.objective = p.objective;
            }
            if (isString(p.lastFailure)) {
                if (p.lastFailure.length > MAX_STATE_TEXT) return fail('updateState: lastFailure grande demais');
                patch.lastFailure = p.lastFailure;
            }
            for (const key of ['plan', 'working', 'broken', 'decisions', 'rollbacks', 'touched'] as const) {
                if (p[key] !== undefined) {
                    const arr = checkStringArray(p[key], MAX_STATE_LIST_ITEMS, MAX_STATE_ITEM_CHARS);
                    if (arr === null) return fail(`updateState: "${key}" inválido`);
                    patch[key] = arr;
                }
            }
            return { ok: true, message: { type: 'updateState', patch } };
        }

        case 'startMission': {
            if (!isString(m.title) || m.title.trim().length === 0) {
                return fail('startMission: "title" ausente');
            }
            if (!isString(m.objective) || m.objective.trim().length === 0) {
                return fail('startMission: "objective" ausente');
            }
            if (m.title.length > 500) return fail('startMission: title grande demais');
            if (m.objective.length > MAX_QUESTION) return fail('startMission: objective grande demais');
            return { ok: true, message: { type: 'startMission', title: m.title, objective: m.objective } };
        }

        case 'cancelRun': {
            const reason = isString(m.reason) ? m.reason.slice(0, 500) : 'cancelado';
            return { ok: true, message: { type: 'cancelRun', reason } };
        }

        case 'getRun': {
            return { ok: true, message: { type: 'getRun' } };
        }

        case 'startMultiAgentMission': {
            if (!isString(m.title) || m.title.trim().length === 0) return fail('startMultiAgentMission: "title" ausente');
            if (!isString(m.objective) || m.objective.trim().length === 0) return fail('startMultiAgentMission: "objective" ausente');
            if (m.title.length > 500) return fail('startMultiAgentMission: title grande demais');
            if (m.objective.length > MAX_QUESTION) return fail('startMultiAgentMission: objective grande demais');
            return { ok: true, message: { type: 'startMultiAgentMission', title: m.title, objective: m.objective } };
        }

        case 'dispatchNextTask': {
            return { ok: true, message: { type: 'dispatchNextTask' } };
        }

        case 'submitDeliverable': {
            if (!isString(m.taskId) || m.taskId.length === 0) return fail('submitDeliverable: "taskId" ausente');
            if (!isString(m.summary)) return fail('submitDeliverable: "summary" ausente');
            const knownIssues = Array.isArray(m.knownIssues)
                ? m.knownIssues.filter((x: unknown) => isString(x)).slice(0, 20) as string[]
                : [];
            const files = Array.isArray(m.files)
                ? m.files
                    .filter((x: unknown) => isString(x) && (x as string).length > 0 && (x as string).length <= 1024)
                    .slice(0, 200) as string[]
                : [];
            return {
                ok: true,
                message: {
                    type: 'submitDeliverable',
                    taskId: m.taskId,
                    summary: m.summary.slice(0, 8000),
                    knownIssues,
                    buildPassed: !!m.buildPassed,
                    files
                }
            };
        }

        case 'cancelMultiAgentMission': {
            const reason = isString(m.reason) ? m.reason.slice(0, 500) : 'cancelado';
            return { ok: true, message: { type: 'cancelMultiAgentMission', reason } };
        }

        case 'getMultiAgentState': {
            return { ok: true, message: { type: 'getMultiAgentState' } };
        }

        case 'registerSession': {
            if (!isString(m.sessionId) || m.sessionId.length > 200) return fail('registerSession: "sessionId" inválido');
            if (!isString(m.provider)) return fail('registerSession: "provider" inválido');
            return { ok: true, message: { type: 'registerSession', sessionId: m.sessionId, provider: m.provider } };
        }

        case 'markSessionUnavailable': {
            if (!isString(m.sessionId) || m.sessionId.length > 200) return fail('markSessionUnavailable: "sessionId" inválido');
            return { ok: true, message: { type: 'markSessionUnavailable', sessionId: m.sessionId } };
        }

        case 'reRequest': {
            if (!Array.isArray(m.requests) || m.requests.length === 0 || m.requests.length > MAX_RE_REQUESTS) {
                return fail(`reRequest: "requests" deve ter de 1 a ${MAX_RE_REQUESTS} pedidos`);
            }
            const requests: ReRequestMessage[] = [];
            for (const r of m.requests as unknown[]) {
                if (!r || typeof r !== 'object') return fail('reRequest: pedido inválido');
                const it = r as Record<string, unknown>;
                if (!isString(it.op) || !RE_OPS.has(it.op)) return fail('reRequest: "op" desconhecida');
                if (!isString(it.file) || it.file.length === 0 || it.file.length > MAX_FILEPATH_CHARS) return fail('reRequest: "file" inválido');
                const args = checkStringArray(it.args ?? [], 8, MAX_RE_FIELD);
                if (args === null) return fail('reRequest: "args" inválido');
                const opts: Record<string, string> = {};
                if (it.opts !== undefined) {
                    if (!it.opts || typeof it.opts !== 'object' || Array.isArray(it.opts)) return fail('reRequest: "opts" inválido');
                    const entries = Object.entries(it.opts as Record<string, unknown>);
                    if (entries.length > 16) return fail('reRequest: opções demais');
                    for (const [k, v] of entries) {
                        if (!/^[a-z_]{1,32}$/.test(k) || !isString(v) || v.length > MAX_RE_FIELD) return fail(`reRequest: opção "${k}" inválida`);
                        opts[k] = v;
                    }
                }
                requests.push({ op: it.op, file: it.file, args, opts });
            }
            return { ok: true, message: { type: 'reRequest', requests } };
        }

        default:
            return fail(`tipo desconhecido: ${type}`);
    }
}
