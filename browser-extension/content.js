// Ponto de entrada. Cria o painel, liga os controllers e faz o bootstrap
// (carrega token/prefs, conecta ao VS Code, cola prompt pendente, registra
// a sessão para o multiagente).
(function () {
    'use strict';
    const conn = window.DS.connection;
    const state = window.DS.agentState;
    const ctx = window.DS.context;
    const agent = window.DS.agent;

    async function loadPrefs(panel) {
        try {
            const r = await chrome.storage.local.get(['instantMode', 'selectReview']);
            if (r && r.instantMode) {
                panel.instantMode = true;
                agent.setInstantMode(true);
            }
            if (r && r.selectReview) panel.selectReview = true;
        } catch { /* ignore */ }
    }

    async function promptToken(panel) {
        const current = conn.authToken ? conn.authToken.slice(0, 6) + '…' + conn.authToken.slice(-4) : '(nenhum)';
        const msg = `Token do VS Code (atual: ${current}).\n\n` +
            'No VS Code: Ctrl+Shift+P → "DeepSeek Context Sync: Copiar Token" e cole aqui.';
        const typed = prompt(msg, '');
        if (typed === null) return;
        await conn.saveToken(typed);
        panel.refresh();
        if (!conn.authToken) panel.toast('Token removido.');
        else panel.toast('Token salvo. Reconectando...');
        try { conn.ws && conn.ws.close(); } catch { /* ignore */ }
        clearTimeout(conn.reconnectTimer);
        setTimeout(() => conn.connect(), 500);
    }

    async function handlePendingPrompt(panel) {
        try {
            const res = await chrome.storage.local.get(['pendingPrompt']);
            const pending = res && res.pendingPrompt;
            if (!pending || typeof pending !== 'string' || pending.length === 0) return;
            await chrome.storage.local.remove(['pendingPrompt']);

            const trySet = async (attempts = 40) => {
                const p = window.DS.getProvider();
                const input = p.findInput();
                if (input) { p.setInput(input, pending); return true; }
                if (attempts <= 0) return false;
                await window.DS.protocol.sleep(500);
                return trySet(attempts - 1);
            };
            const ok = await trySet();
            if (ok) panel.toast('🆕 Estado do projeto colado no campo.');
            else panel.toast('⚠️ Não achei o campo para colar o estado.');
        } catch { /* ignore */ }
    }

    async function bootstrap() {
        await conn.loadToken();

        // Callback do "📥 Aplicar": no modo multiagente, envia a entrega;
        // no modo normal, aplica as mudanças como sempre.
        const onApply = () => {
            if (window.DS.multiagent && window.DS.multiagent.currentTaskId) {
                window.DS.multiagent.submitCurrentResponse();
            } else {
                ctx.handleApply();
            }
        };

        const panel = new window.DS.Panel({
            siteName: () => window.DS.siteName(),
            getProvider: () => window.DS.getProvider(),
            onFullContext: () => ctx.handleAttach('full'),
            onAttach: (mode) => ctx.handleAttach(mode),
            onApply,
            onSelect: () => ctx.handleSelectContext(),
            onNewConversation: () => ctx.handleNewConversation(),
            onPromptToken: () => promptToken(panel),
            onSetTimeout: (which, value) => conn.setTimeoutSeconds(which, value)
        });
        window.DS.panel = panel;

        await loadPrefs(panel);

        // Conexão: sincroniza estado + trata eventos
        conn.on('open', () => {
            state.setConnected(true);
            panel.refresh();
            console.log('Conectado ao VS Code Context Sync');
            // Registra (ou reanuncia) esta aba como sessão multiagente
            if (window.DS.session) {
                if (window.DS.session.registered) window.DS.session.reannounce();
                else window.DS.session.register();
            }
        });
        conn.on('close', () => {
            state.setConnected(false);
            panel.refresh();
        });
        conn.on('no-token', () => {
            panel.toast('🔑 Token não configurado. Clique em "🔑 Token" no painel.');
        });
        conn.on('config', () => panel.refresh());
        conn.on('applyResult', (msg) => {
            const icon = msg.status === 'applied' ? '✅' : msg.status === 'cancelled' ? '⏹' : '❌';
            panel.toast(`${icon} ${msg.message || msg.status}`);
        });
        conn.on('error', (msg) => panel.toast('⚠️ ' + (msg.message || 'Erro')));

        // Multiagente
        conn.on('nextTaskDispatch', (msg) => {
            window.DS.multiagent.onNextTaskDispatch(msg);
        });
        conn.on('multiAgentMissionStarted', (msg) => {
            window.DS.multiagent.onMissionStarted(msg);
        });
        conn.on('deliverableRecorded', (msg) => {
            window.DS.multiagent.onDeliverableRecorded(msg);
        });
        conn.on('multiAgentMissionCompleted', (msg) => {
            window.DS.multiagent.onMissionCompleted(msg);
        });
        conn.on('multiAgentMissionCancelled', (msg) => {
            panel.toast('⏹ Missão multiagente cancelada.');
            window.DS.multiagent.cancelMission();
        });
        conn.on('multiAgentError', (msg) => {
            window.DS.multiagent.onError(msg);
        });

        conn.connect();

        // Recupera estado pendente (nova conversa)
        handlePendingPrompt(panel);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        bootstrap();
    }
})();
