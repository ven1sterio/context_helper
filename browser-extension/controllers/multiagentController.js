// Orquestra o fluxo multiagente no navegador: recebe `nextTaskDispatch`,
// cola o prompt no chat, e quando o usuário clica em "📥 Aplicar" envia a
// entrega ao VS Code.
(function () {
    'use strict';
    window.DS = window.DS || {};
    const conn = window.DS.connection;
    const ctx = window.DS.context;

    let currentTaskId = null;
    let currentMission = null;
    let currentContract = null;
    let currentAgentLabel = null;

    function panel() { return window.DS.panel; }

    function startMission(title, objective) {
        if (!conn.isOpen()) {
            panel().toast('Sem conexão com o VS Code.');
            return;
        }
        currentTaskId = null;
        currentMission = null;
        currentContract = null;
        conn.ws.send(JSON.stringify({ type: 'startMultiAgentMission', title, objective }));
    }

    function cancelMission(reason) {
        if (conn.isOpen()) {
            conn.ws.send(JSON.stringify({ type: 'cancelMultiAgentMission', reason: reason || 'cancelado pelo usuário' }));
        }
        currentTaskId = null;
        currentMission = null;
        currentContract = null;
        currentAgentLabel = null;
    }

    async function onNextTaskDispatch(msg) {
        currentTaskId = msg.contract.taskId;
        currentMission = msg.mission;
        currentContract = msg.contract;
        currentAgentLabel = msg.agentLabel;

        const p = window.DS.getProvider();
        const input = p.findInput();
        if (!input) {
            panel().toast('Campo de entrada não encontrado.');
            return;
        }

        // Cola o prompt do papel atual
        await ctx.setInputBig(input, msg.prompt);
        const kind = msg.contract.outputFormat === 'TEXT_ONLY' ? 'texto' : 'código';
        panel().toast(`🤖 ${msg.agentLabel}: revise e envie (${kind}).`);
    }

    /**
     * Lê a resposta atual do modelo, aplica os arquivos (se houver) e envia
     * a entrega. Chamado pelo botão "📥 Aplicar" quando há task multiagente.
     */
    async function submitCurrentResponse() {
        if (!currentTaskId) {
            panel().toast('Nenhuma task multiagente em andamento.');
            return null;
        }

        const p = window.DS.getProvider();
        const node = p.findLastAssistantMessage();
        if (!node) {
            panel().toast('Sem resposta do modelo na página.');
            return null;
        }
        const text = p.messageText(node);
        const parsed = parseLastResponse();

        // Papéis TEXT_ONLY (analista/planejador/revisor/auditor) NÃO devem tocar
        // em arquivos. Se o modelo desobedecer e mandar FILE/EDIT, ignoramos para
        // não sobrescrever o trabalho dos outros papéis.
        const isTextOnly = !!(currentContract && currentContract.outputFormat === 'TEXT_ONLY');

        let files = [];
        let buildPassed = false;

        if (!isTextOnly && !parsed.error && parsed.files && parsed.files.length > 0) {
            panel().toast(`🛠️ Aplicando ${parsed.files.length} bloco(s) antes de enviar...`);
            const res = await conn.applyFiles(parsed.files, { modelStatus: 'done' });
            // FIX BUG CRÍTICO: `applyFiles` devolve null quando está ocupado ou
            // desconectado. Antes submetíamos a entrega mesmo assim — o auditor
            // recebia "arquivos aplicados" que nunca foram parar no disco.
            if (!res) {
                panel().toast('❌ VS Code não respondeu (aplicação ocupada ou desconectada). Entrega NÃO enviada.');
                return null;
            }
            if (res.status === 'applied') {
                files = res.files || [];
                buildPassed = res.runSuccess !== false;
            } else if (res.status === 'cancelled') {
                panel().toast('⏹ Aplicação cancelada. Entrega NÃO enviada.');
                return null;
            } else {
                panel().toast(`❌ Falha ao aplicar: ${res.message || 'erro'}. Entrega NÃO enviada.`);
                return null;
            }
        }

        // Envia a entrega (mesmo sem arquivos, para TEXT_ONLY)
        const summary = text.length > 8000 ? text.slice(0, 8000) : text;
        conn.ws.send(JSON.stringify({
            type: 'submitDeliverable',
            taskId: currentTaskId,
            summary,
            knownIssues: [],
            buildPassed,
            files
        }));

        panel().toast(`📤 Entrega enviada (${files.length} arquivo(s), build ${buildPassed ? 'OK' : 'pendente'}).`);
        return { files, buildPassed, summary: summary.slice(0, 200) };
    }

    function onMissionStarted(msg) {
        currentMission = msg.mission;
        panel().toast(`🎯 Missão iniciada: ${msg.mission.title} (${msg.mission.tasks.length} etapas)`);
    }

    function onDeliverableRecorded(msg) {
        if (msg.accepted) {
            panel().toast(`✅ ${msg.reason || 'Entrega aceita.'}`);
        } else if (msg.reviewPending) {
            panel().toast(`⏳ ${msg.reason || 'Aguardando revisão.'}`);
        } else if (msg.nextTaskId) {
            panel().toast(`⚠️ ${msg.reason || 'Entrega rejeitada.'} Refazendo…`);
        } else {
            panel().toast(`❌ ${msg.reason || 'Entrega rejeitada.'}`);
        }
    }

    function onMissionCompleted(msg) {
        const audit = msg.audit || {};
        const icon = audit.satisfied ? '🏁' : '❌';
        panel().toast(`${icon} Missão ${audit.satisfied ? 'CUMPRIDA' : 'FALHOU'}.`);
        currentTaskId = null;
        currentMission = null;
        currentContract = null;
        currentAgentLabel = null;
    }

    function onError(msg) {
        panel().toast('⚠️ Multiagente: ' + (msg.error || 'erro'));
    }

    window.DS.multiagent = {
        startMission,
        cancelMission,
        onNextTaskDispatch,
        submitCurrentResponse,
        onMissionStarted,
        onDeliverableRecorded,
        onMissionCompleted,
        onError,
        get currentTaskId() { return currentTaskId; },
        get currentMission() { return currentMission; },
        get currentContract() { return currentContract; },
        get currentAgentLabel() { return currentAgentLabel; }
    };
})();
