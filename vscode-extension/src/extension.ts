import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ContextManager } from './contextManager';
import { ApplyManager } from './applyManager';
import { WsServer } from './wsServer';
import { TaskRunner } from './taskRunner';
import { Indexer } from './indexer';
import { GraphStore } from './graphStore';
import { StateManager } from './stateManager';
import { setAllowSensitive, maskSecrets } from './pathRules';
import { PlanManager } from './agent/planManager';
import { TaskQueue } from './agent/taskQueue';
import { RunManager } from './agent/runManager';
import { RunHistory } from './agent/runHistory';
import { RecoveryManager } from './agent/recoveryManager';
import { ProjectMemory } from './memory/projectMemory';
import { AgentRegistry } from './multiagent/agentRegistry';
import { MissionController } from './multiagent/missionController';
import { DeliverableManager } from './multiagent/deliverableManager';
import { ReviewManager } from './multiagent/reviewManager';
import { SessionRouter } from './multiagent/sessionRouter';
import { TaskDispatcher } from './multiagent/taskDispatcher';
import { runHealthCheck } from './diagnostics/healthCheck';
import { showReport } from './diagnostics/diagnosticReport';
import { decompileToProject } from './decompiler';
import { handleReRequests } from './reBridge';
import * as path from 'path';

const TOKEN_KEY = 'deepseekContextSync.token';
const LOG = '[DeepSeek Context Sync]';

function generateToken(): string {
    return crypto.randomBytes(24).toString('hex');
}

export async function activate(context: vscode.ExtensionContext) {
    try {
        await activateInternal(context);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(LOG, 'falha na ativação:', e);
        vscode.window.showErrorMessage(
            `DeepSeek Context Sync: falha ao ativar — ${maskSecrets(msg)}`
        );
    }
}

async function activateInternal(context: vscode.ExtensionContext) {
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        console.warn(LOG, 'ativação demorou > 30s; verifique o Output para ver a etapa travada.');
        vscode.window.showWarningMessage(
            'DeepSeek Context Sync: a ativação está demorando. Veja o Output (dropdown "DeepSeek Context Sync") para diagnosticar.'
        );
    }, 30000);

    try {
        await activateSteps(context, () => timedOut);
    } finally {
        clearTimeout(timer);
    }
}

async function activateSteps(context: vscode.ExtensionContext, isTimedOut: () => boolean) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        console.warn(LOG, 'sem workspace; abortando (abra uma pasta antes de usar a extensão).');
        vscode.window.showErrorMessage(
            'DeepSeek Context Sync: abra uma pasta de projeto primeiro (File → Open Folder) e recarregue.'
        );
        return;
    }
    console.log(LOG, 'workspace:', workspaceRoot);

    setAllowSensitive(
        vscode.workspace.getConfiguration('deepseekContextSync').get<boolean>('allowSensitiveFiles', false)
    );

    let token = context.globalState.get<string>(TOKEN_KEY);
    if (!token) {
        token = generateToken();
        await context.globalState.update(TOKEN_KEY, token);
    }

    const contextManager = new ContextManager(workspaceRoot);
    try {
        contextManager.setReCacheDir(path.join(context.globalStorageUri.fsPath, 're'));
    } catch { /* ignore */ }
    try {
        console.log(LOG, 'inicializando ContextManager...');
        await contextManager.initialize();
        console.log(LOG, 'ContextManager OK');
    } catch (e) {
        console.error(LOG, 'ContextManager falhou:', e);
        vscode.window.showErrorMessage(
            'DeepSeek Context Sync: falha ao ler o workspace. Verifique se a pasta está acessível e recarregue.'
        );
        return;
    }

    const indexer = new Indexer(workspaceRoot);
    try {
        console.log(LOG, 'inicializando Indexer...');
        await indexer.initialize(contextManager);
        console.log(LOG, 'Indexer OK');
    } catch (e) {
        console.error(LOG, 'Indexer falhou:', e);
        vscode.window.showWarningMessage(
            'DeepSeek Context Sync: o Indexer falhou. O contexto completo e o Full Code podem não funcionar.'
        );
    }

    const stateManager = new StateManager(workspaceRoot);
    try {
        await stateManager.initialize();
    } catch (e) {
        console.warn(LOG, 'StateManager falhou:', e);
    }

    const projectMemory = new ProjectMemory(workspaceRoot);
    try {
        await projectMemory.load();
        stateManager.setMemory(projectMemory);
    } catch (e) {
        console.warn(LOG, 'ProjectMemory falhou:', e);
    }

    const applyManager = new ApplyManager(workspaceRoot, {
        findDependents: (rel) => indexer.getDependentsOf(rel),
        allFilePaths: () => new Set(Object.keys(indexer.getIndex().files))
    });
    const taskRunner = new TaskRunner(workspaceRoot);

    console.log(LOG, 'inicializando WsServer em 127.0.0.1:8765...');
    let wsServer: WsServer;
    try {
        wsServer = new WsServer(contextManager, {
            port: 8765,
            token,
            onError: err => {
                const msg = err?.message || String(err);
                if (/token inválido/i.test(msg)) return;
                if (/origem recusada/i.test(msg)) return;
                const code = (err as any)?.code;
                if (code === 'EADDRINUSE' || /EADDRINUSE|address already in use/i.test(msg)) {
                    vscode.window.showErrorMessage(
                        'DeepSeek Context Sync: a porta 8765 já está em uso. ' +
                        'Feche a OUTRA janela do Extension Development Host (ou do VS Code) que está ' +
                        'com a extensão ativa e recarregue esta janela (Ctrl+Shift+P → Developer: Reload Window). ' +
                        'Se persistir, encerre processos Node antigos no Gerenciador de Tarefas.'
                    );
                    return;
                }
                console.error(LOG, 'erro no WsServer:', err);
                vscode.window.showErrorMessage(
                    `DeepSeek Context Sync: erro no servidor (${maskSecrets(msg)}). ` +
                    'Verifique o Output para mais detalhes.'
                );
            }
        });
        console.log(LOG, 'WsServer OK');
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(LOG, 'falha ao criar WsServer:', e);
        vscode.window.showErrorMessage(
            `DeepSeek Context Sync: não foi possível iniciar o servidor local (${maskSecrets(msg)}). ` +
            'Verifique se outra instância está usando a porta 8765.'
        );
        return;
    }
    wsServer.setApplyHandler((files, opts) => applyManager.apply(files, opts));
    wsServer.setApplyAbortHandler(() => applyManager.requestAbort());
    wsServer.setRunner(taskRunner);
    wsServer.setIndexer(indexer);
    const graphStore = new GraphStore(
        workspaceRoot,
        vscode.workspace.getConfiguration('deepseekContextSync').get<string>('graphPath', 'graphify-out/graph.json')
    );
    wsServer.setGraphStore(graphStore);
    wsServer.setStateManager(stateManager);
    wsServer.setReHandler(async (requests) => {
        const cfg = vscode.workspace.getConfiguration('deepseekContextSync');
        if (!cfg.get<boolean>('reEnabled', true)) {
            return { ok: false, text: 'Engenharia reversa desligada (deepseekContextSync.reEnabled).' };
        }
        return handleReRequests(requests, {
            workspaceRoot,
            cacheDir: path.join(context.globalStorageUri.fsPath, 're'),
            ghidraHome: cfg.get<string>('ghidraPath', '') || process.env.GHIDRA_HOME,
            ilspyPath: cfg.get<string>('ilspyPath', 'ilspycmd'),
            maxDecompiledChars: cfg.get<number>('maxDecompiledKB', 200) * 1024,
            confirm: async (text) =>
                (await vscode.window.showWarningMessage(text, { modal: true }, 'Aplicar')) === 'Aplicar'
        });
    });

    const planManager = new PlanManager(workspaceRoot);
    const taskQueue = new TaskQueue(planManager);
    const runHistory = new RunHistory(workspaceRoot);
    const recoveryManager = new RecoveryManager(workspaceRoot);
    const runManager = new RunManager(planManager, taskQueue, runHistory, recoveryManager);

    wsServer.setAgentManagers({
        plan: planManager,
        queue: taskQueue,
        run: runManager,
        recovery: recoveryManager
    });

    const agentRegistry = new AgentRegistry();
    const deliverables = new DeliverableManager();
    const reviews = new ReviewManager();
    const sessions = new SessionRouter();
    const multiagentMission = new MissionController(
        agentRegistry, deliverables, reviews, sessions,
        (e) => console.log(LOG, '[MultiAgent]', e.kind)
    );
    const dispatcher = new TaskDispatcher(agentRegistry, sessions);

    wsServer.setMultiAgentManagers({
        registry: agentRegistry,
        mission: multiagentMission,
        deliverables,
        reviews,
        sessions,
        dispatcher
    });

    try {
        const recovery = await recoveryManager.inspect();
        if (recovery.kind === 'running') {
            const choice = await vscode.window.showInformationMessage(
                `DeepSeek Context Sync: há uma execução interrompida (${recovery.run.id}). Retomar?`,
                'Retomar',
                'Descartar'
            );
            if (choice === 'Retomar') {
                if (recovery.mission) {
                    await planManager.load(recovery.run.missionId);
                }
                await runManager.resumeFrom(recovery.run);
                vscode.window.showInformationMessage(
                    'Execução retomada. Abra o chat e clique em "🔁 Full Code" para continuar.'
                );
            } else {
                await recoveryManager.saveCurrentRun(null);
            }
        } else if (recovery.kind === 'stale') {
            vscode.window.showWarningMessage(
                `DeepSeek Context Sync: execução interrompida não pode ser retomada (${recovery.reason}).`
            );
            await recoveryManager.saveCurrentRun(null);
        }
    } catch (e) {
        console.warn(LOG, 'recovery:', e);
    }

    const indexSub = contextManager.onDidChange(e => {
        if (e.kind === 'deleted') indexer.removeFile(e.relPath);
        else {
            const content = contextManager.getFile(e.relPath);
            if (content !== undefined) indexer.updateFile(e.relPath, content);
            else indexer.removeFile(e.relPath);
        }
    });

    const cfgSub = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('deepseekContextSync.graphPath')) {
            graphStore.setPath(vscode.workspace.getConfiguration('deepseekContextSync').get<string>('graphPath', 'graphify-out/graph.json'));
        }
        if (e.affectsConfiguration('deepseekContextSync.allowSensitiveFiles')) {
            setAllowSensitive(
                vscode.workspace.getConfiguration('deepseekContextSync')
                    .get<boolean>('allowSensitiveFiles', false)
            );
        }
    });

    context.subscriptions.push(
        vscode.commands.registerCommand('deepseekContextSync.copyToken', async () => {
            await vscode.env.clipboard.writeText(token);
            vscode.window.showInformationMessage(
                'Token copiado. Cole no painel do navegador (botão "🔑 Token").'
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('deepseekContextSync.showToken', () => {
            vscode.window.showInformationMessage(
                'Use "DeepSeek Context Sync: Copiar Token" para copiar o token.'
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('deepseekContextSync.decompileDllToProject', async (uri?: vscode.Uri) => {
            let target = uri;
            if (!target) {
                const picked = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    defaultUri: vscode.Uri.file(workspaceRoot),
                    filters: { 'Assemblies .NET': ['dll', 'exe'] },
                    openLabel: 'Decompilar',
                });
                target = picked?.[0];
            }
            if (!target) return;

            const name = path.basename(target.fsPath).replace(/\.(dll|exe)$/i, '');
            const outDir = path.join(workspaceRoot, 'decompiled', name);
            const outUri = vscode.Uri.file(outDir);

            let exists = false;
            try { exists = (await vscode.workspace.fs.readDirectory(outUri)).length > 0; } catch { /* não existe */ }
            if (exists) {
                const choice = await vscode.window.showWarningMessage(
                    `A pasta decompiled/${name} já existe. Substituir apaga as edições feitas nela.`,
                    { modal: true },
                    'Substituir'
                );
                if (choice !== 'Substituir') return;
                await vscode.workspace.fs.delete(outUri, { recursive: true, useTrash: false });
            }

            const cfg = vscode.workspace.getConfiguration('deepseekContextSync');
            const res = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Decompilando ${name} com o ILSpy…` },
                () => decompileToProject(target!.fsPath, outDir, {
                    exePath: cfg.get<string>('ilspyPath', 'ilspycmd') || 'ilspycmd',
                    timeoutMs: 300_000,
                })
            );

            if (!res.ok) {
                if (res.reason === 'not-installed') {
                    vscode.window.showErrorMessage(
                        'ILSpy não encontrado. Instale com: dotnet tool install --global ilspycmd ' +
                        '(ou ajuste "deepseekContextSync.ilspyPath").'
                    );
                } else {
                    vscode.window.showErrorMessage(
                        `Falha ao decompilar ${name} (${res.reason}): ${res.detail}. ` +
                        'Se for uma DLL nativa (C/C++), o ILSpy não a suporta.'
                    );
                }
                return;
            }

            vscode.window.showInformationMessage(
                `Projeto C# gerado em decompiled/${name}. Os arquivos já entram no contexto; ` +
                `depois de editar, recompile com: dotnet build decompiled/${name}`
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('deepseekContextSync.diagnose', () => {
            const report = runHealthCheck({
                workspaceRoot,
                hasContextManager: !!contextManager,
                hasIndexer: !!indexer,
                hasWsServer: !!wsServer,
                hasGraph: !!graphStore,
                hasMemory: !!projectMemory,
                hasAgent: !!runManager,
                hasMultiAgent: !!multiagentMission
            });
            showReport(report, workspaceRoot);
        })
    );

    vscode.window.setStatusBarMessage(
        'DeepSeek Context Sync: WS em 127.0.0.1:8765. Use "Copiar Token" para autorizar o navegador.',
        8000
    );

    console.log(LOG, 'ativação concluída' + (isTimedOut() ? ' (com aviso de lentidão)' : ''));

    context.subscriptions.push({
        dispose: () => {
            try { cfgSub.dispose(); } catch { /* ignore */ }
            try { indexSub.dispose(); } catch { /* ignore */ }
            try { projectMemory.dispose(); } catch { /* ignore */ }
            try { stateManager.dispose(); } catch { /* ignore */ }
            try { planManager.dispose(); } catch { /* ignore */ }
            try { indexer.dispose(); } catch { /* ignore */ }
            try { contextManager.dispose(); } catch { /* ignore */ }
            try { applyManager.dispose(); } catch { /* ignore */ }
            try { wsServer.dispose(); } catch { /* ignore */ }
            try { taskRunner.dispose(); } catch { /* ignore */ }
        }
    });
}

export function deactivate() {
    // No-op intencional: a limpeza real está em context.subscriptions.dispose().
}
