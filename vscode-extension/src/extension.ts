import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ContextManager } from './contextManager';
import { ApplyManager } from './applyManager';
import { WsServer } from './wsServer';
import { TaskRunner } from './taskRunner';
import { Indexer } from './indexer';
import { StateManager } from './stateManager';
import { QuotaManager } from './quota';
import { GeminiClient } from './geminiClient';
import { Summarizer } from './summarizer';
import { setAllowSensitive, maskSecrets } from './pathRules';
import { getTimeouts } from './timeouts';

const TOKEN_KEY = 'deepseekContextSync.token';
const GEMINI_KEY = 'gemini-key';

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

    // ---------- Fase 3: Gemini ----------
    const getCfg = () => vscode.workspace.getConfiguration('deepseekContextSync');
    const getGeminiEnabled = () => getCfg().get<boolean>('geminiEnabled', false);
    const getGeminiModel = () => getCfg().get<string>('geminiModel', 'gemini-2.0-flash');

    const quota = new QuotaManager(
        context.globalState,
        () => getCfg().get<number>('geminiDailyBudget', 200),
        msg => vscode.window.setStatusBarMessage(msg, 8000)
    );

    const gemini = new GeminiClient(
        async () => {
            try { return await context.secrets.get(GEMINI_KEY); }
            catch { return undefined; }
        },
        getGeminiModel
    );

    const summarizer = new Summarizer(
        indexer,
        gemini,
        quota,
        getGeminiEnabled,
        () => getTimeouts().gemini,
        msg => vscode.window.setStatusBarMessage(msg, 6000)
    );

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
    wsServer.setGemini({ quota, client: gemini, summarizer, isEnabled: getGeminiEnabled });
    wsServer.setStateManager(stateManager);

    const indexSub = contextManager.onDidChange(e => {
        if (e.kind === 'deleted') indexer.removeFile(e.relPath);
        else {
            const content = contextManager.getFile(e.relPath);
            if (content !== undefined) indexer.updateFile(e.relPath, content);
            else indexer.removeFile(e.relPath);
        }
        summarizer.schedule();
    });

    const cfgSub = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('deepseekContextSync.allowSensitiveFiles')) {
            setAllowSensitive(
                vscode.workspace.getConfiguration('deepseekContextSync')
                    .get<boolean>('allowSensitiveFiles', false)
            );
        }
        if (e.affectsConfiguration('deepseekContextSync.geminiEnabled')
            || e.affectsConfiguration('deepseekContextSync.geminiModel')) {
            if (getGeminiEnabled()) summarizer.schedule();
            else summarizer.cancel();
        }
    });

    if (getGeminiEnabled()) summarizer.schedule();

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
        vscode.commands.registerCommand('deepseekContextSync.setGeminiKey', async () => {
            const key = await vscode.window.showInputBox({
                title: 'Chave da API do Gemini',
                prompt: 'A chave será guardada no SecretStorage do VS Code (nunca em settings.json nem em log).',
                password: true,
                ignoreFocusOut: true,
                placeHolder: 'AIza...',
                validateInput: v => {
                    const t = (v || '').trim();
                    if (!t) return 'Cole a chave.';
                    if (t.length < 20) return 'Chave parece curta demais.';
                    if (/\s/.test(t)) return 'A chave não deve conter espaços.';
                    return null;
                }
            });
            if (!key) return;
            await context.secrets.store(GEMINI_KEY, key.trim());
            vscode.window.showInformationMessage(
                '🔐 Chave do Gemini salva no SecretStorage. Ligue "deepseekContextSync.geminiEnabled" para usar.'
            );
            if (getGeminiEnabled()) summarizer.schedule();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('deepseekContextSync.clearGeminiKey', async () => {
            await context.secrets.delete(GEMINI_KEY);
            vscode.window.showInformationMessage('🗑️ Chave do Gemini removida do SecretStorage.');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('deepseekContextSync.runSummaries', async () => {
            if (!getGeminiEnabled()) {
                vscode.window.showWarningMessage(
                    'Gemini está desligado. Ligue "deepseekContextSync.geminiEnabled" primeiro.'
                );
                return;
            }
            vscode.window.showInformationMessage('🤖 Gerando resumos com o Gemini em segundo plano...');
            summarizer.schedule();
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
            summarizer.dispose();
            stateManager.dispose();
            indexer.dispose();
            contextManager.dispose();
            applyManager.dispose();
            wsServer.dispose();
            taskRunner.dispose();
        }
    });
}
