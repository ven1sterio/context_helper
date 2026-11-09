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

const TOKEN_KEY = 'deepseekContextSync.token';

function generateToken(): string {
    return crypto.randomBytes(24).toString('hex');
}

export async function activate(context: vscode.ExtensionContext) {
    try {
        await activateInternal(context);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[DeepSeek Context Sync] falha na ativação:', e);
        vscode.window.showErrorMessage(
            `DeepSeek Context Sync: falha ao ativar — ${maskSecrets(msg)}`
        );
    }
}

async function activateInternal(context: vscode.ExtensionContext) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('Abra uma pasta de projeto primeiro.');
        return;
    }

    setAllowSensitive(
        vscode.workspace.getConfiguration('deepseekContextSync').get<boolean>('allowSensitiveFiles', false)
    );

    let token = context.globalState.get<string>(TOKEN_KEY);
    if (!token) {
        token = generateToken();
        await context.globalState.update(TOKEN_KEY, token);
    }

    const contextManager = new ContextManager(workspaceRoot);
    await contextManager.initialize();

    const indexer = new Indexer(workspaceRoot);
    await indexer.initialize(contextManager);

    // ---------- Fase 5: estado entre conversas ----------
    const stateManager = new StateManager(workspaceRoot);
    await stateManager.initialize();

    // ---------- Fase 3: memória estruturada ----------
    const projectMemory = new ProjectMemory(workspaceRoot);
    await projectMemory.load();
    stateManager.setMemory(projectMemory);

    const applyManager = new ApplyManager(workspaceRoot);
    const taskRunner = new TaskRunner(workspaceRoot);

    const wsServer = new WsServer(contextManager, {
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
                    'Feche a outra janela do Extension Development Host (ou do VS Code) ' +
                    'que está com a extensão ativa e pressione F5 de novo. Se persistir, ' +
                    'encerre processos Node antigos no Gerenciador de Tarefas.'
                );
                return;
            }
            vscode.window.showErrorMessage(
                `DeepSeek Context Sync: erro no servidor (${maskSecrets(msg)}). ` +
                'Se a porta 8765 estiver em uso, feche outras janelas de desenvolvimento.'
            );
        }
    });
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

    // ---------- Fase 2: Full Code 2.0 ----------
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

    // Recovery: verifica run interrompida ao ativar
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
        console.error('[DeepSeek Context Sync] recovery:', e);
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

    vscode.window.setStatusBarMessage(
        'DeepSeek Context Sync: WS em 127.0.0.1:8765. Use "Copiar Token" para autorizar o navegador.',
        8000
    );

    context.subscriptions.push({
        dispose: () => {
            cfgSub.dispose();
            indexSub.dispose();
            projectMemory.dispose();
            stateManager.dispose();
            planManager.dispose();
            indexer.dispose();
            contextManager.dispose();
            applyManager.dispose();
            wsServer.dispose();
            taskRunner.dispose();
        }
    });
}

export function deactivate() {
    // No-op intencional: a limpeza real está em context.subscriptions.dispose().
}
