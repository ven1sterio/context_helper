import * as vscode from 'vscode';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import { ContextManager, ChangeKind } from './contextManager';
import { ApplyResult } from './applyPlan';
import { TaskRunner } from './taskRunner';
import { Indexer } from './indexer';
import { StateManager, StateUpdate } from './stateManager';
import { selectFiles, buildSelectiveContext, ScoredFile } from './selector';
import { GraphStore } from './graphStore';
import { selectWithGraph } from './graphSelector';
import { getTimeouts, timeoutsPayload, ALLOWED_TIMEOUTS } from './timeouts';

export interface ApplyOptions {
    auto?: boolean;
}

export type ApplyHandler = (files: unknown, options?: ApplyOptions) => Promise<ApplyResult>;

export interface WsServerOptions {
    port?: number;
    token: string;
    onError?: (err: Error) => void;
}

const ALLOWED_ORIGINS = [
    'https://chat.deepseek.com',
    'https://gemini.google.com',
    'https://chatgpt.com',
    'https://chat.openai.com'
];

export class WsServer {
    private wss: WebSocketServer;
    private token: string;
    private applyHandler?: ApplyHandler;
    private applyAbortHandler?: () => void;
    private runner?: TaskRunner;
    private indexer?: Indexer;
    private graphStore?: GraphStore;
    private lastSelectionInfo: { source: string; stale: number; report: string } = { source: 'local', stale: 0, report: '' };
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
                if (ALLOWED_ORIGINS.includes(origin) || origin.startsWith('chrome-extension://')) {
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
                || e.affectsConfiguration('deepseekContextSync.runTimeoutSec')) {
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
                        run: 'runTimeout'
                    };
                    let targets: string[];
                    if (which === 'agent') targets = ['response', 'run'];
                    else if (which === 'all') targets = ['response', 'run'];
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

                if (msg.type === 'selectContext') {
                    if (!this.indexer) { send({ type: 'selection', error: 'Índice não disponível.' }); return; }
                    const request = String(msg.request || '').trim();
                    if (!request) { send({ type: 'selection', error: 'Digite o pedido antes de usar o seletivo.' }); return; }
                    try {
                        const selected = this.selectLocal(request);
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
                        send({ type: 'selection', files, total, request,
                            source: this.lastSelectionInfo.source, stale: this.lastSelectionInfo.stale });
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
                            type: 'selectionContext',
                            data: (this.lastSelectionInfo.report
                                ? '[VISÃO GERAL DO PROJETO — graphify]\n' + this.lastSelectionInfo.report + '\n\n' : '') + result.text,
                            tree: this.contextManager.buildTree(),
                            files: result.included.length + result.skeleton.length,
                            chars: result.chars, tokens: result.tokens,
                            included: result.included, skeleton: result.skeleton, missing: result.missing
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

    private selectLocal(request: string): ScoredFile[] {
        if (!this.indexer) return [];
        const contents = this.contextManager.getAllFiles();
        const local = selectFiles(request, this.indexer.getIndex(), 40, contents);

        const mode = vscode.workspace.getConfiguration('deepseekContextSync').get<string>('useGraph', 'auto');
        this.lastSelectionInfo = { source: 'local', stale: 0, report: '' };
        if (mode === 'off' || !this.graphStore) return local;

        if (!this.graphStore.load(new Set(contents.keys()))) return local;
        const graph = this.graphStore.get();
        if (!graph) return local;

        const sel = selectWithGraph(request, graph, local, { maxFiles: 40 });
        if (!sel.usedGraph) return local;
        this.lastSelectionInfo = {
            source: local.length > 0 ? 'híbrido' : 'grafo',
            stale: this.graphStore.staleCount(contents.keys()),
            report: sel.seeds.length < 3 ? this.graphStore.readReport() : ''
        };
        return sel.files;
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
    setGraphStore(store: GraphStore) { this.graphStore = store; }
    setStateManager(mgr: StateManager) { this.stateManager = mgr; }
    getToken(): string { return this.token; }

    dispose() {
        this.configSub?.dispose();
        // Encerra à força todas as conexões ANTES de fechar o servidor.
        // Sem isso, wss.close() fica esperando os clientes (o navegador reconecta
        // sozinho), o processo do Extension Host demora a sair e a porta 8765
        // continua presa — o próximo F5 falha ao abrir a porta (EADDRINUSE) e a
        // janela nova tende a abrir e fechar até o processo antigo morrer.
        try {
            for (const client of this.wss.clients) {
                try { client.terminate(); } catch { /* ignore */ }
            }
        } catch { /* ignore */ }
        try { this.wss.close(); } catch { /* ignore */ }
    }
}

export { getTimeouts };
