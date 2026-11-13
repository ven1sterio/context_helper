import * as vscode from 'vscode';
import * as path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { ContextManager, ChangeKind } from './contextManager';
import { ApplyResult } from './applyPlan';
import { TaskRunner } from './taskRunner';
import { Indexer } from './indexer';
import { StateManager, StateUpdate } from './stateManager';
import { selectFiles, buildSelectiveContext, ScoredFile } from './selector';
import { GraphStore } from './graphStore';
import { selectWithGraph } from './graphSelector';
import { getTimeouts, timeoutsPayload, ALLOWED_TIMEOUTS } from './timeouts';
import { AuthProtocol } from './security/authProtocol';
import { validateMessage } from './security/messageValidator';
import { PlanManager } from './agent/planManager';
import { TaskQueue } from './agent/taskQueue';
import { RunManager, AdvanceResult } from './agent/runManager';
import { RecoveryManager } from './agent/recoveryManager';
import { IterationRecord } from './agent/agentTypes';
import { hashContent, fingerprintFile } from './fileFingerprint';
import { AgentRegistry } from './multiagent/agentRegistry';
import { MissionController } from './multiagent/missionController';
import { DeliverableManager } from './multiagent/deliverableManager';
import { ReviewManager } from './multiagent/reviewManager';
import { SessionRouter } from './multiagent/sessionRouter';
import { TaskDispatcher } from './multiagent/taskDispatcher';

export interface AgentManagers {
    plan: PlanManager;
    queue: TaskQueue;
    run: RunManager;
    recovery: RecoveryManager;
}

export interface MultiAgentManagers {
    registry: AgentRegistry;
    mission: MissionController;
    deliverables: DeliverableManager;
    reviews: ReviewManager;
    sessions: SessionRouter;
    dispatcher: TaskDispatcher;
}

export interface ApplyOptions {
    auto?: boolean;
    conflicts?: string[];
}

export interface ReHandlerResult { ok: boolean; text: string; results?: unknown[] }
export type ReHandler = (requests: any[]) => Promise<ReHandlerResult>;

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
    private reHandler?: ReHandler;
    private runner?: TaskRunner;
    private indexer?: Indexer;
    private graphStore?: GraphStore;
    private lastSelectionInfo: { source: string; stale: number; report: string } = { source: 'local', stale: 0, report: '' };
    private stateManager?: StateManager;
    private agents?: AgentManagers;
    private multiagent?: MultiAgentManagers;
    private abortRequested = false;
    private configSub: vscode.Disposable | null = null;
    private contextSubs: vscode.Disposable[] = [];

    constructor(private contextManager: ContextManager, options: WsServerOptions) {
        this.token = options.token;
        const port = options.port ?? 8765;
        const maxPayload = 12 * 1024 * 1024;

        this.wss = new WebSocketServer({
            port,
            host: '127.0.0.1',
            maxPayload,
            verifyClient: (info, cb) => {
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

        // Falhas de decompilação chegam ao navegador (toast) mesmo com o
        // painel do VS Code minimizado — e não dependem de uma conexão
        // específica aberta.
        this.contextSubs.push(
            this.contextManager.onDecompileFailure(failure => {
                this.broadcast({ type: 'decompileFailed', ...failure });
            })
        );

        this.wss.on('connection', (ws) => {
            const pending = new Map<string, ChangeKind>();
            let treeDirty = false;
            let sentFull = false;

            const sentFingerprints = new Map<string, string>();

            const subs = [
                this.contextManager.onDidChange(e => { pending.set(e.relPath, e.kind); }),
                this.contextManager.onDidChangeTree(() => { treeDirty = true; }),
                this.contextManager.onDecompileProgress(snap => {
                    send({ type: 'decompileProgress', ...snap });
                })
            ];

            const send = (payload: object) => {
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
            };

            const registerFingerprint = (rel: string) => {
                const content = this.contextManager.getFile(rel);
                if (content !== undefined) sentFingerprints.set(rel, hashContent(content));
            };

            const sendNextDispatch = () => {
                if (!this.multiagent) return;
                const context = this.contextManager.buildFull().text;
                const d = this.multiagent.mission.dispatchNext(context);
                if (!d) {
                    const plan = this.multiagent.mission.currentPlan;
                    if (plan && plan.tasks.every(t => t.status === 'accepted' || t.status === 'failed')) {
                        const { audit } = this.multiagent.mission.complete();
                        send({
                            type: 'multiAgentMissionCompleted',
                            mission: this.multiagent.mission.currentPlan,
                            audit
                        });
                    } else {
                        send({
                            type: 'multiAgentError',
                            error: 'Missão sem próxima task pronta e ainda não concluída. ' +
                                'Provavelmente nenhuma sessão de navegador está disponível ' +
                                'ou há uma task bloqueada.'
                        });
                    }
                    return;
                }
                send({
                    type: 'nextTaskDispatch',
                    contract: d.contract,
                    prompt: d.prompt,
                    agentLabel: d.agent.label,
                    mission: this.multiagent.mission.currentPlan
                });
            };

            const auth = new AuthProtocol({
                token: this.token,
                onAuthenticated: () => {
                    send({ type: 'config', timeouts: timeoutsPayload() });
                    send({ type: 'decompileProgress', ...this.contextManager.getDecompileProgress() });
                },
                onRejected: (reason) => {
                    send({ type: 'error', message: `Autenticação falhou: ${reason}` });
                    try { ws.close(1008, 'Auth failed'); } catch { /* ignore */ }
                }
            });
            auth.start();
            send({ type: 'auth-required' });

            ws.on('message', async raw => {
                let msg: any;
                try { msg = JSON.parse(raw.toString()); } catch { return; }
                if (!msg || typeof msg !== 'object') return;

                if (!auth.isAuthenticated()) {
                    auth.handleMessage(msg);
                    return;
                }

                const v = validateMessage(msg);
                if (!v.ok) {
                    send({ type: 'error', message: v.error });
                    return;
                }
                const m = v.message;

                switch (m.type) {
                    case 'ping':
                        return;

                    case 'abort': {
                        this.abortRequested = true;
                        try { this.applyAbortHandler?.(); } catch { /* ignore */ }
                        try { this.runner?.cancel(); } catch { /* ignore */ }
                        send({ type: 'aborted', ok: true });
                        return;
                    }

                    case 'setTimeout': {
                        const cfg = vscode.workspace.getConfiguration('deepseekContextSync');
                        const map: Record<string, string> = {
                            response: 'responseTimeout',
                            run: 'runTimeout'
                        };
                        if (!ALLOWED_TIMEOUTS.includes(m.value)) {
                            send({ type: 'error', message: 'Timeout inválido (use 60, 300 ou 600 segundos).' });
                            return;
                        }
                        let targets: string[];
                        if (m.which === 'agent' || m.which === 'all') targets = ['response', 'run'];
                        else if (m.which in map) targets = [m.which];
                        else { send({ type: 'error', message: `Timeout desconhecido: ${m.which}` }); return; }
                        try {
                            for (const t of targets) {
                                await cfg.update(map[t], m.value, vscode.ConfigurationTarget.Global);
                            }
                            send({ type: 'config', timeouts: timeoutsPayload() });
                        } catch (e) {
                            send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
                        }
                        return;
                    }

                    case 'updateState': {
                        if (!this.stateManager) { send({ type: 'stateUpdated', ok: false }); return; }
                        this.stateManager.update(m.patch as StateUpdate);
                        send({ type: 'stateUpdated', ok: true });
                        return;
                    }

                    case 'getState': {
                        if (!this.stateManager) { send({ type: 'state', state: '' }); return; }
                        send({ type: 'state', state: this.stateManager.toMarkdownWithMemory() });
                        return;
                    }

                    case 'selectContext': {
                        if (!this.indexer) { send({ type: 'selection', error: 'Índice não disponível.' }); return; }
                        const request = m.request.trim();
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

                    case 'buildSelection': {
                        if (!this.indexer) { send({ type: 'selectionContext', error: 'Índice não disponível.' }); return; }
                        const paths = m.paths;
                        if (paths.length === 0) { send({ type: 'selectionContext', error: 'Nenhum arquivo selecionado.' }); return; }
                        try {
                            const maxTokens = vscode.workspace.getConfiguration('deepseekContextSync')
                                .get<number>('maxContextTokens', 120000);
                            const result = buildSelectiveContext(paths, maxTokens, this.contextManager.getAllFiles(), this.indexer.getIndex());

                            for (const rel of [...result.included, ...result.skeleton]) {
                                registerFingerprint(rel);
                            }

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

                    case 'request': {
                        if (m.mode === 'full' || !sentFull) {
                            let awaitRes: { timedOut: boolean; stillPending: string[] } = { timedOut: false, stillPending: [] };
                            try {
                                awaitRes = await this.contextManager.awaitDecompiles(45000);
                            } catch { /* segue com o que já tem */ }

                            const useBudget = vscode.workspace.getConfiguration('deepseekContextSync')
                                .get<boolean>('useContextBudget', true);
                            const r = (useBudget && this.indexer)
                                ? this.contextManager.buildFullWithBudget(this.fullBudgetTokens(), this.indexer.getIndex())
                                : this.contextManager.buildFull();

                            pending.clear(); treeDirty = false; sentFull = true;

                            const omittedSet = new Set(r.omitted);
                            for (const [rel] of this.contextManager.getAllFiles()) {
                                if (omittedSet.has(rel)) continue;
                                registerFingerprint(rel);
                            }

                            send({
                                type: 'context', mode: 'full', data: r.text,
                                tree: this.contextManager.buildTree(),
                                files: r.files, chars: r.chars, omitted: r.omitted.length,
                                decompileTimedOut: awaitRes.timedOut,
                                decompilePending: awaitRes.stillPending
                            });
                        } else {
                            const r = this.contextManager.buildDelta(pending);
                            for (const p of r.included) pending.delete(p);
                            const sendTree = treeDirty; treeDirty = false;

                            for (const rel of r.included) {
                                const content = this.contextManager.getFile(rel);
                                if (content !== undefined) registerFingerprint(rel);
                                else sentFingerprints.delete(rel);
                            }

                            send({
                                type: 'context',
                                mode: (r.included.length > 0 || sendTree) ? 'delta' : 'empty',
                                data: r.text,
                                tree: sendTree ? this.contextManager.buildTree() : undefined,
                                files: r.included.length, chars: r.chars, remaining: pending.size
                            });
                        }
                        return;
                    }

                    case 'reRequest': {
                        if (!this.reHandler) {
                            send({ type: 'reResult', ok: false, text: 'Engenharia reversa não está disponível nesta instância do VS Code.' });
                            return;
                        }
                        try {
                            const r = await this.reHandler(m.requests);
                            send({ type: 'reResult', ok: r.ok, text: r.text, results: r.results });
                        } catch (e) {
                            send({ type: 'reResult', ok: false, text: 'ERRO: ' + (e instanceof Error ? e.message : String(e)) });
                        }
                        return;
                    }

                    case 'applyFiles': {
                        if (!this.applyHandler) { send({ type: 'applyResult', status: 'error', message: 'Aplicação não disponível.' }); return; }
                        try {
                            const auto = m.autoApply;
                            const runAfter = m.runAfter;
                            this.abortRequested = false;
                            const startedAt = new Date().toISOString();

                            const uniquePaths = new Set<string>();
                            for (const it of m.files) {
                                if (it && typeof it === 'object') {
                                    const itObj = it as any;
                                    if (typeof itObj.filePath === 'string') uniquePaths.add(itObj.filePath);
                                    if (typeof itObj.moveFrom === 'string') uniquePaths.add(itObj.moveFrom);
                                }
                            }
                            const conflicts = this.detectConflicts([...uniquePaths], sentFingerprints);

                            if (conflicts.length > 0 && auto) {
                                send({
                                    type: 'applyResult',
                                    status: 'error',
                                    message: 'Conflito de arquivos:\n' + conflicts.join('\n'),
                                    conflicts
                                });
                                return;
                            }

                            const result = await this.applyHandler(m.files, { auto, conflicts });

                            const iteration: IterationRecord = {
                                index: (this.agents?.run.currentRun?.iterations.length ?? 0) + 1,
                                startedAt,
                                endedAt: undefined,
                                appliedFiles: result.files ?? [],
                                errors: [],
                                status: result.status === 'error'
                                    ? 'apply-failed'
                                    : result.status === 'cancelled'
                                    ? 'cancelled'
                                    : ((result.files && result.files.length > 0) ? 'applied' : 'no-files'),
                                modelStatus: m.modelStatus
                            };
                            if (result.status === 'error') iteration.errors.push(result.message);
                            if (conflicts.length > 0) iteration.errors.push(...conflicts.map(c => `conflito: ${c}`));

                            if (this.abortRequested) {
                                iteration.status = 'cancelled';
                                iteration.errors.push('cancelado pelo usuário');
                                iteration.endedAt = new Date().toISOString();
                                send({
                                    type: 'applyResult', status: 'cancelled',
                                    message: 'Cancelado pelo usuário.',
                                    files: result.files,
                                    iteration,
                                    nextAction: 'stop',
                                    nextReason: 'cancelado'
                                });
                                return;
                            }

                            let runAfterResult: any = null;
                            if (auto && runAfter && result.status === 'applied') {
                                if (this.runner) {
                                    const run = await this.runner.run();
                                    runAfterResult = run;
                                    if (this.abortRequested || run.aborted) {
                                        iteration.status = 'cancelled';
                                        iteration.errors.push('cancelado');
                                    } else {
                                        iteration.runSuccess = run.success;
                                        iteration.runCommand = run.command;
                                        iteration.runExitCode = run.exitCode;
                                        iteration.runOutputTail = (run.output || '').slice(-2000);
                                        if (!run.success) iteration.status = 'applied-build-failed';
                                    }
                                } else {
                                    iteration.runSuccess = true;
                                    iteration.runCommand = '(sem runner)';
                                }
                            }
                            iteration.endedAt = new Date().toISOString();

                            if (result.status === 'applied' && result.files && result.files.length > 0) {
                                const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                                if (root) {
                                    for (const rel of result.files) {
                                        const abs = path.join(root, rel.split('/').join(path.sep));
                                        const fp = fingerprintFile(abs);
                                        if (fp) sentFingerprints.set(rel, fp);
                                        else sentFingerprints.delete(rel);
                                    }
                                }
                            }

                            let advance: AdvanceResult | null = null;
                            if (this.agents && m.missionId) {
                                try {
                                    advance = await this.agents.run.recordIteration({
                                        iteration,
                                        modelStatus: m.modelStatus
                                    });
                                } catch (e) {
                                    console.error('[DeepSeek Context Sync] recordIteration:', e);
                                }
                            }

                            const response: any = {
                                type: 'applyResult',
                                ...result,
                                iteration,
                                nextAction: advance?.action,
                                nextReason: advance?.reason,
                                nextPrompt: this.buildNextPrompt(advance, m.modelStatus, iteration),
                                mission: advance?.mission ?? null,
                                conflicts: conflicts.length > 0 ? conflicts : undefined
                            };
                            if (runAfterResult) {
                                response.runSuccess = runAfterResult.success;
                                response.runCommand = runAfterResult.command;
                                response.runOutput = runAfterResult.output;
                                response.runDurationMs = runAfterResult.durationMs;
                                response.runExitCode = runAfterResult.exitCode;
                                response.runVia = runAfterResult.via;
                            }
                            send(response);
                        } catch (e) {
                            send({ type: 'applyResult', status: 'error', message: e instanceof Error ? e.message : String(e) });
                        }
                        return;
                    }

                    case 'startMission': {
                        if (!this.agents) {
                            send({ type: 'missionStarted', error: 'Agente não disponível.' });
                            return;
                        }
                        try {
                            const run = await this.agents.run.start(m.title, m.objective);
                            send({
                                type: 'missionStarted',
                                missionId: run.missionId,
                                runId: run.id,
                                taskId: this.agents.plan.current?.tasks[0]?.id ?? null
                            });
                        } catch (e) {
                            send({
                                type: 'missionStarted',
                                error: e instanceof Error ? e.message : String(e)
                            });
                        }
                        return;
                    }

                    case 'cancelRun': {
                        if (this.agents) {
                            try { await this.agents.run.cancel(m.reason); } catch { /* ignore */ }
                        }
                        send({ type: 'runCancelled', ok: true });
                        return;
                    }

                    case 'getRun': {
                        send({
                            type: 'runState',
                            run: this.agents?.run.currentRun ?? null,
                            mission: this.agents?.plan.current ?? null
                        });
                        return;
                    }

                    case 'startMultiAgentMission': {
                        if (!this.multiagent) { send({ type: 'multiAgentError', error: 'Multiagente não disponível.' }); return; }
                        try {
                            const plan = this.multiagent.mission.start({ title: m.title, objective: m.objective });
                            send({ type: 'multiAgentMissionStarted', mission: plan });
                            sendNextDispatch();
                        } catch (e) {
                            send({ type: 'multiAgentError', error: e instanceof Error ? e.message : String(e) });
                        }
                        return;
                    }

                    case 'dispatchNextTask': {
                        if (!this.multiagent) { send({ type: 'multiAgentError', error: 'Multiagente não disponível.' }); return; }
                        sendNextDispatch();
                        return;
                    }

                    case 'submitDeliverable': {
                        if (!this.multiagent) { send({ type: 'multiAgentError', error: 'Multiagente não disponível.' }); return; }
                        try {
                            const result = this.multiagent.mission.recordDelivery({
                                taskId: m.taskId,
                                files: m.files || [],
                                summary: m.summary,
                                knownIssues: m.knownIssues,
                                buildPassed: m.buildPassed
                            });
                            send({
                                type: 'deliverableRecorded',
                                ...result,
                                mission: this.multiagent.mission.currentPlan
                            });
                            if (result.missionCompleted) {
                                send({
                                    type: 'multiAgentMissionCompleted',
                                    mission: this.multiagent.mission.currentPlan,
                                    audit: result.audit
                                });
                            } else {
                                sendNextDispatch();
                            }
                        } catch (e) {
                            send({ type: 'multiAgentError', error: e instanceof Error ? e.message : String(e) });
                        }
                        return;
                    }

                    case 'cancelMultiAgentMission': {
                        if (!this.multiagent) { send({ type: 'multiAgentError', error: 'Multiagente não disponível.' }); return; }
                        this.multiagent.mission.cancel(m.reason);
                        send({ type: 'multiAgentMissionCancelled', mission: this.multiagent.mission.currentPlan });
                        return;
                    }

                    case 'getMultiAgentState': {
                        if (!this.multiagent) { send({ type: 'multiAgentState', mission: null }); return; }
                        send({
                            type: 'multiAgentState',
                            mission: this.multiagent.mission.currentPlan,
                            availability: this.multiagent.dispatcher.listAvailability(),
                            sessions: this.multiagent.sessions.list()
                        });
                        return;
                    }

                    case 'registerSession': {
                        if (this.multiagent) {
                            this.multiagent.sessions.register(m.sessionId, m.provider as any);
                        }
                        send({ type: 'sessionRegistered', sessionId: m.sessionId });
                        return;
                    }

                    case 'markSessionUnavailable': {
                        if (this.multiagent) {
                            this.multiagent.sessions.markAvailable(m.sessionId, false);
                        }
                        return;
                    }
                }
            });

            ws.on('close', () => {
                auth.dispose();
                subs.forEach(s => s.dispose());
            });
        });
    }

    private detectConflicts(uniquePaths: string[], sentFingerprints: Map<string, string>): string[] {
        const conflicts: string[] = [];
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) return conflicts;
        for (const rel of uniquePaths) {
            const expected = sentFingerprints.get(rel);
            if (!expected) continue;
            const abs = path.join(root, rel.split('/').join(path.sep));
            const current = fingerprintFile(abs);
            if (current === null) {
                conflicts.push(`${rel}: não existe mais no disco`);
            } else if (current !== expected) {
                conflicts.push(`${rel}: modificado no VS Code desde o último envio de contexto`);
            }
        }
        return conflicts;
    }

    private fullBudgetTokens(): number {
        const kb = vscode.workspace.getConfiguration('deepseekContextSync').get<number>('maxTotalKB', 800);
        return Math.max(2000, Math.floor(kb * 1024 / 4));
    }

    private buildNextPrompt(
        advance: AdvanceResult | null,
        modelStatus: 'continue' | 'done' | null,
        iteration: IterationRecord
    ): string | undefined {
        if (!advance) return undefined;
        if (advance.action === 'done' || advance.action === 'stop') return undefined;

        if (advance.action === 'retry') {
            if (iteration.errors.some(e => e.startsWith('conflito:'))) {
                return 'Conflito detectado: o arquivo mudou no VS Code desde o envio do contexto. ' +
                    'Não sobrescreva sem ver o estado atual. Peça ao usuário para revisar ou reenvie ' +
                    'a etapa depois de eu enviar o contexto atualizado.\n' +
                    'Termine com [[STATUS:CONTINUAR]] ou [[STATUS:CONCLUIDO]] e depois [[FIM-DA-RESPOSTA]].';
            }
            if (iteration.status === 'apply-failed') {
                return `Falha ao aplicar:\n${iteration.errors.join('\n')}\n\n` +
                    `Reenvie os arquivos corrigidos. Use "### FILE:" se o EDIT não casar. ` +
                    `Termine com [[STATUS:CONTINUAR]] ou [[STATUS:CONCLUIDO]] e depois [[FIM-DA-RESPOSTA]].`;
            }
            if (iteration.status === 'applied-build-failed') {
                const out = (iteration.runOutputTail || '').slice(-6000);
                return `Os arquivos foram aplicados mas a execução falhou.\n\n` +
                    `Comando: ${iteration.runCommand || '(desconhecido)'}` +
                    (typeof iteration.runExitCode === 'number' ? ` (código ${iteration.runExitCode})` : '') +
                    `\nSaída:\n\`\`\`\n${out}\n\`\`\`\n\n` +
                    `Corrija e reenvie os arquivos (máx 20). ` +
                    `Termine com [[STATUS:CONTINUAR]] ou [[STATUS:CONCLUIDO]] e depois [[FIM-DA-RESPOSTA]].`;
            }
            if (iteration.status === 'no-files') {
                return `Você marcou [[STATUS:CONTINUAR]] mas não enviou arquivos. ` +
                    `Envie agora os arquivos da próxima etapa. ` +
                    `Termine com [[STATUS:CONTINUAR]] ou [[STATUS:CONCLUIDO]] e depois [[FIM-DA-RESPOSTA]].`;
            }
            return `Reenvie a etapa corrigida. Termine com [[STATUS:CONTINUAR]] ou [[STATUS:CONCLUIDO]] e depois [[FIM-DA-RESPOSTA]].`;
        }

        if (modelStatus === 'done') {
            return `Etapa concluída. Continue com a PRÓXIMA etapa do seu plano. ` +
                `Termine com [[STATUS:CONTINUAR]] ou [[STATUS:CONCLUIDO]] e depois [[FIM-DA-RESPOSTA]].`;
        }
        return `Continue com a próxima etapa do seu plano. ` +
            `Termine com [[STATUS:CONTINUAR]] ou [[STATUS:CONCLUIDO]] e depois [[FIM-DA-RESPOSTA]].`;
    }

    private selectLocal(request: string): ScoredFile[] {
        if (!this.indexer) return [];
        const contents = this.contextManager.getAllFiles();
        const local = selectFiles(request, this.indexer.getIndex(), 40, contents, { semantic: true });

        const mode = vscode.workspace.getConfiguration('deepseekContextSync').get<string>('useGraph', 'auto');
        this.lastSelectionInfo = { source: 'local', stale: 0, report: '' };
        if (mode === 'off' || !this.graphStore) return local;

        if (!this.graphStore.load(new Set(contents.keys()))) return local;
        const graph = this.graphStore.get();
        if (!graph) return local;

        const sel = selectWithGraph(request, graph, local, {
            maxFiles: 40,
            impactBonus: 2,
            dependentsOf: (rel) => this.indexer ? this.indexer.getDependentsOf(rel) : []
        });
        if (!sel.usedGraph) return local;
        this.lastSelectionInfo = {
            source: local.length > 0 ? 'híbrido' : 'grafo',
            stale: this.graphStore.staleCount(contents.keys()),
            report: sel.seeds.length < 3 ? this.graphStore.readReport() : ''
        };
        return sel.files;
    }

    private broadcast(payload: object): void {
        const data = JSON.stringify(payload);
        for (const client of this.wss.clients) {
            if (client.readyState === WebSocket.OPEN) client.send(data);
        }
    }

    private broadcastConfig(): void {
        this.broadcast({ type: 'config', timeouts: timeoutsPayload() });
    }

    setApplyHandler(handler: ApplyHandler) { this.applyHandler = handler; }
    setApplyAbortHandler(handler: () => void) { this.applyAbortHandler = handler; }
    setRunner(runner: TaskRunner) { this.runner = runner; }
    setIndexer(indexer: Indexer) { this.indexer = indexer; }
    setGraphStore(store: GraphStore) { this.graphStore = store; }
    setStateManager(mgr: StateManager) { this.stateManager = mgr; }
    setReHandler(fn: ReHandler) { this.reHandler = fn; }
    setAgentManagers(m: AgentManagers) { this.agents = m; }
    setMultiAgentManagers(m: MultiAgentManagers) { this.multiagent = m; }
    getToken(): string { return this.token; }

    dispose() {
        this.configSub?.dispose();
        for (const s of this.contextSubs) { try { s.dispose(); } catch { /* ignore */ } }
        this.contextSubs = [];
        try {
            for (const client of this.wss.clients) {
                try { client.terminate(); } catch { /* ignore */ }
            }
        } catch { /* ignore */ }
        try { this.wss.close(); } catch { /* ignore */ }
    }
}

export { getTimeouts };
