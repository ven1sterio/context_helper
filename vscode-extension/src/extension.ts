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

const TOKEN_KEY = 'deepseekContextSync.token';

function generateToken(): string {
    return crypto.randomBytes(24).toString('hex');
}

export async function activate(context: vscode.ExtensionContext) {
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

    const applyManager = new ApplyManager(workspaceRoot);
    const taskRunner = new TaskRunner(workspaceRoot);

    const wsServer = new WsServer(contextManager, {
        port: 8765,
        token,
        onError: err => {
            const msg = err?.message || String(err);
            if (/token inválido/i.test(msg)) return;
            if (/origem recusada/i.test(msg)) return;
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
            stateManager.dispose();
            indexer.dispose();
            contextManager.dispose();
            applyManager.dispose();
            wsServer.dispose();
            taskRunner.dispose();
        }
    });
}
