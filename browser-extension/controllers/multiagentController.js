// Orquestra o fluxo multiagente no navegador: recebe `nextTaskDispatch`,
// cola o prompt no chat, e quando o usuário clica em "📥 Aplicar" envia a
// entrega ao VS Code.
(function () {
    'use strict';
    window.DS = window.DS || {};
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const conn = window.DS.connection;
    const ctx = window.DS.context;

    let currentTaskId = null;
    let currentMission = null;
    let currentContract = null;
    let currentAgentLabel = null;

    function panel() { return window.DS.panel; }

    // --- Split N-ário dos anexos (espelha o que contextController.js faz) ---
    // O `N` é sempre o número REAL de repartições. Nome único por parte para o
    // hasAttachmentChip do provider não confundir: "contexto-projeto-2-de-3.txt".

    const ATTACH_NAME = 'contexto-projeto.txt';

    function attachNameFor(index, total) {
        if (total <= 1) return ATTACH_NAME;
        return `contexto-projeto-${index + 1}-de-${total}.txt`;
    }

    const MAX_PARTS = 10;

    function splitPrompt(data, maxChars) {
        if (!data || data.length <= maxChars) return [data || ''];
        const minChunks = Math.ceil(data.length / maxChars);
        if (minChunks > MAX_PARTS) {
            const truncated = data.slice(0, maxChars * MAX_PARTS) +
                `\n\n[PROMPT TRUNCADO: excede ${MAX_PARTS} partes]\n`;
            return splitPrompt(truncated, maxChars);
        }
        const targetSize = Math.ceil(data.length / minChunks);
        const chunks = [];
        let remaining = data;
        while (remaining.length > 0) {
            if (remaining.length <= targetSize) {
                chunks.push(remaining);
                break;
            }
            let cut = remaining.lastIndexOf('\n--- ', targetSize);
            if (cut < targetSize / 2) cut = targetSize;
            chunks.push(remaining.slice(0, cut));
            remaining = remaining.slice(cut);
        }
        return chunks;
    }

    function headerFor(index, total) {
        const part = total > 1 ? ` — parte ${index + 1} de ${total}` : '';
        return `[TAREFA MULTIAGENTE${part}]`;
    }

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

        // Cola o prompt do papel atual. Prompt grande (contexto do projeto embutido) vai como
        // ANEXO, nunca colado inteiro: colar centenas de KB dá "Content is too long".
        // Se o anexo único ainda passar do limite de upload da página, divide em N partes.
        const limit = p.maxInlineChars || 40000;
        const supportsFiles = !!(p.supportsFileAttach && p.attachTextFile);

        if (msg.prompt.length > limit && supportsFiles) {
            const chunks = splitPrompt(msg.prompt, limit);
            const total = chunks.length;

            // Já existe algum chip nosso no campo? (por parte)
            for (let i = 0; i < total; i++) {
                const name = attachNameFor(i, total);
                if (p.hasAttachmentChip && p.hasAttachmentChip(name)) {
                    panel().toast(`⚠️ Já há um anexo "${name}" no campo. Remova-o (×) antes de continuar.`);
                    return;
                }
            }

            const note = total === 1
                ? `(O prompt completo desta tarefa está no ANEXO "${attachNameFor(0, 1)}". ` +
                  `Leia-o inteiro e responda no formato exigido nele.)`
                : `(O prompt completo desta tarefa está nos ${total} ANEXOS ` +
                  `"${attachNameFor(0, total)}" a "${attachNameFor(total - 1, total)}". ` +
                  `Leia TODOS, na ordem, e responda no formato exigido neles.)`;

            await ctx.setInputBig(input, note);
            await sleep(400);

            let currentInput = p.findInput() || input;
            for (let i = 0; i < total; i++) {
                const name = attachNameFor(i, total);
                const content = headerFor(i, total) + '\n' + chunks[i];
                const ok = await p.attachTextFile(currentInput, content, name);
                if (!ok) {
                    await sleep(3000);
                    if (!(p.hasAttachmentChip && p.hasAttachmentChip(name))) {
                        // Aborta em vez de colar inline (duplicaria contexto).
                        panel().toast(
                            `⚠️ Falha ao anexar "${name}" (parte ${i + 1}/${total}). ` +
                            `Remova os anexos já feitos antes de continuar.`);
                        return;
                    }
                }
                if (i < total - 1) await sleep(500);
                currentInput = p.findInput() || currentInput;
            }
        } else {
            await ctx.setInputBig(input, msg.prompt.length > limit ? msg.prompt.slice(0, limit) + '\n[PROMPT TRUNCADO]\n' : msg.prompt);
        }
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
