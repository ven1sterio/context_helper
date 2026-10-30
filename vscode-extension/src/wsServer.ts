import * as vscode from 'vscode';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import { ContextManager, ChangeKind } from './contextManager';
import { ApplyResult } from './applyPlan';
import { TaskRunner } from './taskRunner';
import { Indexer } from './indexer';
import { StateManager, StateUpdate } from './stateManager';
import { selectFiles, buildSelectiveContext, mergeWithGemini, ScoredFile } from './selector';
import { getTimeouts, timeoutsPayload, ALLOWED_TIMEOUTS } from './timeouts';
import { QuotaManager } from './quota';
import { GeminiClient } from './geminiClient';
import { Summarizer } from './summarizer';

export interface ApplyOptions {
    auto?: boolean;
}

export type ApplyHandler = (files: unknown, options?: ApplyOptions) => Promise<ApplyResult>;

interface GeminiBundle {
    quota: QuotaManager;
    client: GeminiClient;
    summarizer: Summarizer;
    isEnabled: () => boolean;
}

export interface WsServerOptions {
    port?: number;
    token: string;
    onError?: (err: Error) => void;
}

interface GeminiRouteItem {
    path: string;
    reason?: string;
}

interface GeminiRouteResponse {
    files?: GeminiRouteItem[];
    reason?: string;
}

export class WsServer {
    private wss: WebSocketServer;
    private token: string;
    private applyHandler?: ApplyHandler;
    private applyAbortHandler?: () => void;
    private runner?: TaskRunner;
    private indexer?: Indexer;
    private gemini?: GeminiBundle;
    private stateManager?: StateManager;
    private abortRequested = false;
    private configSub: vscode.Disposable | null = null;

    constructor(private contextManager: ContextManager, options: WsServerOptions) {
        this.token = options.token;
        const port = options.port ?? 8765;
        const maxPayload = 12 * 1024 * 1024;

        this.wss = new WebSocketServer({
            port,
            host: '127.0.0.1',
            maxPayload,
            verifyClient: (info, cb) => {
                let supplied = '';
                try {
                    const url = new URL(info.req.url || '/', `http://127.0.0.1:${port}`);
                    supplied = url.searchParams.get('token') || '';
                } catch { supplied = ''; }
                if (supplied !== this.token) {
                    options.onError?.(new Error('token inválido — configure o token no painel do navegador'));
                    cb(false, 1008, 'Invalid token');
                    return;
                }
                const origin = (info.origin || (info.req.headers.origin as string | undefined) || '').trim();
                if (!origin) { cb(true); return; }
                if (origin === 'https://chat.deepseek.com' || origin.startsWith('chrome-extension://')) {
                    cb(true); return;
                }
                options.onError?.(new Error(`origem recusada: ${origin}`));
                cb(false, 1008, 'Origin not allowed');
            }
        });
        this.wss.on('error', err => options.onError?.(err));

        this.configSub = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('deepseekContextSync.responseTimeout')
                || e.affectsConfiguration('deepseekContextSync.runTimeout')
                || e.affectsConfiguration('deepseekContextSync.runTimeoutSec')
                || e.affectsConfiguration('deepseekContextSync.geminiTimeout')) {
                this.broadcastConfig();
            }
        });

        this.wss.on('connection', (ws) => {
            ws.send(JSON.stringify({ type: 'config', timeouts: timeoutsPayload() }));

            const pending = new Map<string, ChangeKind>();
            let treeDirty = false;
            let sentFull = false;

            const subs = [
                this.contextManager.onDidChange(e => { pending.set(e.relPath, e.kind); }),
                this.contextManager.onDidChangeTree(() => { treeDirty = true; })
            ];

            const send = (payload: object) => {
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
            };

            ws.on('message', async raw => {
                let msg: any;
                try { msg = JSON.parse(raw.toString()); } catch { return; }
                if (!msg || typeof msg !== 'object') return;

                if (msg.type === 'ping') return;

                if (msg.type === 'abort') {
                    this.abortRequested = true;
                    try { this.applyAbortHandler?.(); } catch { /* ignore */ }
                    try { this.runner?.cancel(); } catch { /* ignore */ }
                    try { this.gemini?.summarizer.cancel(); } catch { /* ignore */ }
                    send({ type: 'aborted', ok: true });
                    return;
                }

                if (msg.type === 'setTimeout') {
                    const which = String(msg.which || '');
                    const value = Number(msg.value);
                    if (!ALLOWED_TIMEOUTS.includes(value)) {
                        send({ type: 'error', message: 'Timeout inválido (use 60, 300 ou 600 segundos).' });
                        return;
                    }
                    const cfg = vscode.workspace.getConfiguration('deepseekContextSync');
                    const map: Record<string, string> = {
                        response: 'responseTimeout',
                        run: 'runTimeout',
                        gemini: 'geminiTimeout'
                    };
                    let targets: string[];
                    if (which === 'agent') targets = ['response', 'run'];
                    else if (which === 'all') targets = ['response', 'run', 'gemini'];
                    else if (which in map) targets = [which];
                    else { send({ type: 'error', message: `Timeout desconhecido: ${which}` }); return; }
                    try {
                        for (const t of targets) {
                            await cfg.update(map[t], value, vscode.ConfigurationTarget.Global);
                        }
                        send({ type: 'config', timeouts: timeoutsPayload() });
                    } catch (e) {
                        send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
                    }
                    return;
                }

                // ---------- Fase 5: estado ----------
                if (msg.type === 'updateState') {
                    if (!this.stateManager) { send({ type: 'stateUpdated', ok: false }); return; }
                    const patch: StateUpdate = {};
                    if (typeof msg.patch === 'object' && msg.patch) {
                        const p = msg.patch;
                        if (typeof p.objective === 'string') patch.objective = p.objective;
                        if (Array.isArray(p.plan)) patch.plan = p.plan.filter((x: any) => typeof x === 'string');
                        if (Array.isArray(p.working)) patch.working = p.working.filter((x: any) => typeof x === 'string');
                        if (Array.isArray(p.broken)) patch.broken = p.broken.filter((x: any) => typeof x === 'string');
                        if (Array.isArray(p.decisions)) patch.decisions = p.decisions.filter((x: any) => typeof x === 'string');
                        if (Array.isArray(p.rollbacks)) patch.rollbacks = p.rollbacks.filter((x: any) => typeof x === 'string');
                        if (typeof p.lastFailure === 'string') patch.lastFailure = p.lastFailure;
                        if (Array.isArray(p.touched)) patch.touched = p.touched.filter((x: any) => typeof x === 'string');
                    }
                    this.stateManager.update(patch);
                    send({ type: 'stateUpdated', ok: true });
                    return;
                }

                if (msg.type === 'getState') {
                    if (!this.stateManager) { send({ type: 'state', state: '' }); return; }
                    send({ type: 'state', state: this.stateManager.toMarkdown() });
                    return;
                }

                if (msg.type === 'geminiStatus') {
                    if (!this.gemini) { send({ type: 'geminiStatus', enabled: false }); return; }
                    send({ type: 'geminiStatus', enabled: this.gemini.isEnabled(), quota: this.gemini.quota.getStatus() });
                    return;
                }

                if (msg.type === 'runSummaries') {
                    if (!this.gemini || !this.gemini.isEnabled()) {
                        send({ type: 'error', message: 'Gemini está desligado.' });
                        return;
                    }
                    this.gemini.summarizer.schedule();
                    send({ type: 'summariesStarted', ok: true });
                    return;
                }

                if (msg.type === 'selectContext') {
                    if (!this.indexer) { send({ type: 'selection', error: 'Índice não disponível.' }); return; }
                    const request = String(msg.request || '').trim();
                    if (!request) { send({ type: 'selection', error: 'Digite o pedido antes de usar o seletivo.' }); return; }
                    try {
                        const selected = await this.selectWithOptionalGemini(request);
                        if (selected.length === 0) {
                            send({ type: 'selection', files: [], total: 0, request, error: 'Nenhum arquivo corresponde ao pedido.' });
                            return;
                        }
                        const idx = this.indexer.getIndex();
                        let total = 0;
                        const files = selected.map((f: ScoredFile) => {
                            const entry = idx.files[f.path];
                            const tokens = entry?.tokens ?? 0;
                            total += tokens;
                            return { path: f.path, score: Math.round(f.score * 10) / 10, tokens, reasons: f.reasons.slice(0, 3) };
                        });
                        send({ type: 'selection', files, total, request, gemini: this.gemini?.isEnabled() ? true : false });
                    } catch (e) {
                        send({ type: 'selection', error: 'Falha ao selecionar: ' + (e instanceof Error ? e.message : String(e)) });
                    }
                    return;
                }

                if (msg.type === 'buildSelection') {
                    if (!this.indexer) { send({ type: 'selectionContext', error: 'Índice não disponível.' }); return; }
                    const paths: string[] = Array.isArray(msg.paths)
                        ? msg.paths.filter((p: any) => typeof p === 'string' && p.length > 0) : [];
                    if (paths.length === 0) { send({ type: 'selectionContext', error: 'Nenhum arquivo selecionado.' }); return; }
                    try {
                        const maxTokens = vscode.workspace.getConfiguration('deepseekContextSync')
                            .get<number>('maxContextTokens', 120000);
                        const result = buildSelectiveContext(paths, maxTokens, this.contextManager.getAllFiles(), this.indexer.getIndex());
                        send({
                            type: 'selectionContext', data: result.text,
                            tree: this.contextManager.buildTree(),
                            files: result.included.length + result.skeleton.length,
                            chars: result.chars, tokens: result.tokens,
                            included: result.included, skeleton: result.skeleton
                        });
                    } catch (e) {
                        send({ type: 'selectionContext', error: 'Falha ao montar contexto: ' + (e instanceof Error ? e.message : String(e)) });
                    }
                    return;
                }

                if (msg.type === 'request') {
                    if (msg.mode === 'full' || !sentFull) {
                        const r = this.contextManager.buildFull();
                        pending.clear(); treeDirty = false; sentFull = true;
                        send({
                            type: 'context', mode: 'full', data: r.text,
                            tree: this.contextManager.buildTree(),
                            files: r.files, chars: r.chars, omitted: r.omitted.length
                        });
                    } else {
                        const r = this.contextManager.buildDelta(pending);
                        for (const p of r.included) pending.delete(p);
                        const sendTree = treeDirty; treeDirty = false;
                        send({
                            type: 'context',
                            mode: (r.included.length > 0 || sendTree) ? 'delta' : 'empty',
                            data: r.text,
                            tree: sendTree ? this.contextManager.buildTree() : undefined,
                            files: r.included.length, chars: r.chars, remaining: pending.size
                        });
                    }
                } else if (msg.type === 'applyFiles') {
                    if (!this.applyHandler) { send({ type: 'applyResult', status: 'error', message: 'Aplicação não disponível.' }); return; }
                    try {
                        const auto = !!msg.autoApply;
                        const runAfter = !!msg.runAfter;
                        this.abortRequested = false;

                        const result = await this.applyHandler(msg.files, { auto });
                        if (this.abortRequested) {
                            send({ type: 'applyResult', status: 'cancelled', message: 'Cancelado pelo usuário.', files: result.files });
                            return;
                        }

                        if (auto && runAfter && result.status === 'applied') {
                            if (this.runner) {
                                const run = await this.runner.run();
                                if (this.abortRequested || run.aborted) {
                                    send({
                                        type: 'applyResult', status: 'cancelled', message: 'Cancelado pelo usuário.',
                                        files: result.files, runSuccess: false, runCommand: run.command, runOutput: run.output,
                                        runDurationMs: run.durationMs, runExitCode: run.exitCode, runVia: run.via
                                    });
                                } else {
                                    send({
                                        type: 'applyResult', ...result,
                                        runSuccess: run.success, runCommand: run.command, runOutput: run.output,
                                        runDurationMs: run.durationMs, runExitCode: run.exitCode, runVia: run.via
                                    });
                                }
                            } else {
                                send({ type: 'applyResult', ...result, runSuccess: true, runOutput: '(Sem runner configurado.)' });
                            }
                        } else {
                            send({ type: 'applyResult', ...result });
                        }
                    } catch (e) {
                        send({ type: 'applyResult', status: 'error', message: e instanceof Error ? e.message : String(e) });
                    }
                }
            });

            ws.on('close', () => subs.forEach(s => s.dispose()));
        });
    }

    private async selectWithOptionalGemini(request: string): Promise<ScoredFile[]> {
        if (!this.indexer) return [];
        const index = this.indexer.getIndex();
        const local = selectFiles(request, index, 25);

        if (!this.gemini || !this.gemini.isEnabled()) return local;
        if (!this.gemini.quota.canCallNow()) {
            const ok = await this.gemini.quota.acquire();
            if (!ok) return local;
        } else {
            await this.gemini.quota.acquire();
        }

        try {
            const route = await this.gemini.client.callJson<GeminiRouteResponse>({
                system:
                    'Você é um roteador de arquivos de projeto. Recebe um pedido em linguagem natural e ' +
                    'uma lista de arquivos (com resumos e símbolos) e devolve JSON: {"files":[{"path":"...","reason":"..."}]}. ' +
                    'Escolha de 3 a 15 arquivos realmente relevantes. NÃO inclua explicação fora do JSON.',
                prompt: this.buildRoutePrompt(request, local),
                timeoutSec: getTimeouts().gemini
            });
            if (!route.ok) {
                if (route.error === 'rate-limit') {
                    const canRetry = await this.gemini.quota.backoff();
                    if (!canRetry) return local;
                    const retry = await this.gemini.client.callJson<GeminiRouteResponse>({
                        system: 'Responda só JSON: {"files":[{"path":"...","reason":"..."}]}.',
                        prompt: this.buildRoutePrompt(request, local),
                        timeoutSec: getTimeouts().gemini
                    });
                    if (!retry.ok) return local;
                    return this.combine(local, retry.data);
                }
                return local;
            }
            return this.combine(local, route.data);
        } catch { return local; }
    }

    private combine(local: ScoredFile[], gemini: GeminiRouteResponse): ScoredFile[] {
        if (!this.indexer) return local;
        const items: GeminiRouteItem[] = Array.isArray(gemini?.files)
            ? gemini.files.filter(x => x && typeof x.path === 'string') : [];
        if (items.length === 0) return local;
        return mergeWithGemini(local, items, this.indexer.getIndex(), 25);
    }

    private buildRoutePrompt(request: string, local: ScoredFile[]): string {
        if (!this.indexer) return '';
        const idx = this.indexer.getIndex();
        const candidates = new Set<string>(local.map(l => l.path));
        const allEntries = Object.entries(idx.files).sort((a, b) => a[1].tokens - b[1].tokens).slice(0, 120);
        for (const [rel] of allEntries) candidates.add(rel);

        const lines: string[] = [];
        lines.push(`Pedido: ${request}`);
        lines.push('');
        lines.push('Arquivos disponíveis (path | tokens | resumo | símbolos):');
        for (const rel of [...candidates].sort()) {
            const e = idx.files[rel];
            if (!e) continue;
            const summary = (e.summary || '').slice(0, 120) || '(sem resumo)';
            const syms = e.symbols.slice(0, 5).map(s => s.name).join(', ');
            lines.push(`- ${rel} | ${e.tokens}t | ${summary} | ${syms}`);
        }
        lines.push('');
        lines.push('Devolva {"files":[{"path":"...","reason":"..."}]} com até 15 caminhos.');
        return lines.join('\n');
    }

    private broadcastConfig(): void {
        const payload = JSON.stringify({ type: 'config', timeouts: timeoutsPayload() });
        for (const client of this.wss.clients) {
            if (client.readyState === WebSocket.OPEN) client.send(payload);
        }
    }

    setApplyHandler(handler: ApplyHandler) { this.applyHandler = handler; }
    setApplyAbortHandler(handler: () => void) { this.applyAbortHandler = handler; }
    setRunner(runner: TaskRunner) { this.runner = runner; }
    setIndexer(indexer: Indexer) { this.indexer = indexer; }
    setGemini(bundle: GeminiBundle) { this.gemini = bundle; }
    setStateManager(mgr: StateManager) { this.stateManager = mgr; }
    getToken(): string { return this.token; }

    dispose() {
        this.configSub?.dispose();
        this.wss.close();
    }
}

export { getTimeouts };
