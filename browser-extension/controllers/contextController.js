// Compõe prompts, anexa/cola no chat, pede contexto e aplica.
// Delega tudo ao provider — este arquivo não conhece DeepSeek/Gemini.
(function () {
    'use strict';
    window.DS = window.DS || {};
    const { sleep } = window.DS.protocol;
    const conn = window.DS.connection;

    const ATTACH_NOTE = '(O conteúdo dos arquivos está no ANEXO "contexto-projeto.txt" desta mensagem. ' +
        'Leia-o inteiro antes de responder; os caminhos e o formato das respostas seguem as regras acima.)';

    function composePrompt(kind, { tree, data, question, fullCode }) {
        const p = window.DS.getProvider();
        const build = (ctx) => kind === 'full'
            ? buildFullPrompt({ tree, context: ctx, question, fullCode })
            : buildDeltaPrompt({ tree, changes: ctx, question, fullCode });
        const asFile = !!(p.supportsFileAttach && p.attachTextFile && data && data.length > (p.maxInlineChars || Infinity));
        return {
            text: build(asFile ? ATTACH_NOTE : data),
            fileText: asFile ? ('[CONTEXTO ATUAL DOS ARQUIVOS]\n' + data) : null,
            inline: () => build(data)
        };
    }

    async function setInputBig(input, text) {
        const p = window.DS.getProvider();
        if (p.setInputChunked && text.length > (p.maxInlineChars || 40000)) {
            const ok = await p.setInputChunked(input, text, (pct) =>
                window.DS.panel.toast(`⌨️ Colando no campo… ${pct}%`));
            if (!ok) window.DS.panel.toast('⚠️ O campo pode ter recebido só parte do texto. Confira antes de enviar.');
            return;
        }
        p.setInput(input, text);
    }

    async function deliverPrompt(input, composed) {
        const p = window.DS.getProvider();
        if (composed.fileText) {
            window.DS.panel.toast('📎 Anexando o contexto como arquivo (evita travar o ' + window.DS.siteName() + ')...');
            p.setInput(input, composed.text);
            await sleep(250);
            const ok = await p.attachTextFile(input, composed.fileText, 'contexto-projeto.txt');
            if (ok) return { attached: true };
            window.DS.panel.toast('⚠️ Não consegui anexar o arquivo. Colando o texto em partes...');
            await setInputBig(input, composed.inline());
            return { attached: false };
        }
        await setInputBig(input, composed.text);
        return { attached: false };
    }

    async function handleAttach(mode) {
        const state = window.DS.agentState;
        if (state.state === window.DS.STATES.RUNNING || state.state === window.DS.STATES.APPLYING) {
            window.DS.panel.toast('Aguarde o agente terminar ou pare-o.');
            return;
        }
        const p = window.DS.getProvider();
        const input = p.findInput();
        if (!input) { window.DS.panel.toast('Campo de entrada não encontrado.'); return; }

        const current = p.readInput(input);
        if (current.includes(PROMPT_MARKER)) {
            window.DS.panel.toast('O campo já contém um contexto anexado.');
            return;
        }
        const question = current.trim();

        window.DS.panel.toast('Buscando contexto...');
        const msg = await conn.requestContext(mode);
        if (!msg) { window.DS.panel.toast('Sem resposta do VS Code.'); return; }
        if (msg.mode === 'empty') { window.DS.panel.toast('Nenhuma alteração desde o último envio.'); return; }

        const kb = (msg.chars / 1024).toFixed(1);

        if (msg.mode === 'full') {
            await deliverPrompt(input, composePrompt('full', { tree: msg.tree, data: msg.data, question, fullCode: false }));
            conn.nextIsDelta = true;
            let info = `Contexto completo: ${msg.files} arquivo(s), ${kb} KB.`;
            if (msg.omitted > 0) info += ` ${msg.omitted} omitido(s) por limite de tamanho.`;
            window.DS.panel.toast(info);
        } else {
            await deliverPrompt(input, composePrompt('delta', { tree: msg.tree, data: msg.data, question, fullCode: false }));
            let info = `Alterações: ${msg.files} arquivo(s), ${kb} KB.`;
            if (msg.tree) info += ' Estrutura atualizada.';
            if (msg.remaining > 0) info += ` Restam ${msg.remaining}; clique de novo para enviar.`;
            window.DS.panel.toast(info);
        }
        window.DS.panel.refresh();
    }

    async function handleApply() {
        const state = window.DS.agentState;
        if (state.state === window.DS.STATES.RUNNING || state.state === window.DS.STATES.APPLYING) {
            window.DS.panel.toast('Aguarde o agente terminar.');
            return;
        }
        if (!conn.isOpen()) { window.DS.panel.toast('Sem conexão com o VS Code.'); return; }

        const result = parseLastResponse();
        if (result.error) { window.DS.panel.toast(result.error); return; }
        if (result.problems.length > 0) {
            alert('O modelo não seguiu o contrato:\n\n' + result.problems.join('\n') + '\n\nNada será aplicado.');
            return;
        }

        window.DS.panel.toast(`Aguardando confirmação no VS Code (${result.files.length} bloco(s))...`);
        const res = await conn.applyFilesManual(result.files);
        if (res && res.type === 'applyResult') {
            const icon = res.status === 'applied' ? '✅' : res.status === 'cancelled' ? '⏹' : '❌';
            window.DS.panel.toast(`${icon} ${res.message || res.status}`);
        }
    }

    async function handleSelectContext() {
        const state = window.DS.agentState;
        if (state.state === window.DS.STATES.RUNNING || state.state === window.DS.STATES.APPLYING) {
            window.DS.panel.toast('Aguarde o agente terminar.');
            return;
        }
        if (window.DS.panel.fullCodeMode) { window.DS.panel.toast('O seletivo é só no modo manual.'); return; }
        if (!conn.isOpen()) { window.DS.panel.toast('Sem conexão com o VS Code.'); return; }

        const p = window.DS.getProvider();
        const input = p.findInput();
        if (!input) { window.DS.panel.toast('Campo de entrada não encontrado.'); return; }

        const current = p.readInput(input);
        if (current.includes(PROMPT_MARKER)) {
            window.DS.panel.toast('O campo já contém contexto. Envie ou limpe antes.');
            return;
        }
        const question = current.trim();
        if (!question) { window.DS.panel.toast('Digite o pedido antes de clicar em "🎯 Seletivo".'); return; }

        window.DS.panel.toast('Analisando arquivos relevantes...');
        const res = await conn.requestSelection('selectContext', { request: question });
        if (!res) { window.DS.panel.toast('Sem resposta do VS Code.'); return; }
        if (res.error) { window.DS.panel.toast('⚠️ ' + res.error); return; }
        if (!res.files || res.files.length === 0) { window.DS.panel.toast('Nenhum arquivo corresponde ao pedido.'); return; }

        const origem = res.source && res.source !== 'local' ? ` (via ${res.source})` : '';
        if (res.stale > 0) window.DS.panel.toast(`⚠️ O graph.json está desatualizado (${res.stale} arquivos mais novos).`);
        else window.DS.panel.toast(`🎯 ${res.files.length} arquivo(s) escolhidos${origem}.`);

        if (window.DS.panel.selectReview) {
            window.DS.panel.showSelection(res.files, res.total, question);
            return;
        }
        window.DS.panel.selectionState = { files: res.files, total: res.total, request: question };
        await buildAndPasteSelection(res.files.map(f => f.path), question);
    }

    async function buildAndPasteSelection(paths, question) {
        window.DS.panel.toast(`📦 Lendo ${paths.length} arquivo(s)...`);
        const res = await conn.requestSelection('buildSelection', { paths });
        if (!res) { window.DS.panel.toast('Sem resposta do VS Code.'); return; }
        if (res.error) { window.DS.panel.toast('⚠️ ' + res.error); return; }
        if (!res.data || !res.data.trim() || (res.files || 0) === 0) {
            window.DS.panel.toast('⚠️ Os arquivos escolhidos não têm conteúdo. Ajuste o pedido.');
            return;
        }

        const p = window.DS.getProvider();
        const input = p.findInput();
        if (!input) { window.DS.panel.toast('Campo de entrada perdido.'); return; }

        await deliverPrompt(input, composePrompt('full', { tree: res.tree, data: res.data, question, fullCode: false }));
        conn.nextIsDelta = true;

        const kTokens = ((res.tokens || 0) / 1000).toFixed(1);
        let extra = (res.skeleton && res.skeleton.length > 0) ? ` (${res.skeleton.length} só como esqueleto)` : '';
        if (res.missing && res.missing.length > 0) extra += ` ⚠️ ${res.missing.length} sem conteúdo no VS Code`;
        window.DS.panel.toast(`🎯 Contexto seletivo: ${res.files} arquivo(s)${extra}, ~${kTokens}k tokens.`);
        window.DS.panel.hideSelection();
        window.DS.panel.refresh();
    }

    async function handleNewConversation() {
        if (!conn.isOpen()) { window.DS.panel.toast('Sem conexão com o VS Code.'); return; }
        const state = window.DS.agentState;
        if (state.state === window.DS.STATES.RUNNING || state.state === window.DS.STATES.APPLYING) {
            window.DS.panel.toast('⏹ Parando o agente antes de abrir nova conversa...');
            await window.DS.agent.stop();
            await sleep(800);
        }

        const stateRes = await conn.requestState();
        const stateText = (stateRes && stateRes.state) || '';

        const handoff =
            '[CONTINUAÇÃO DE TRABALHO]\n\n' +
            (stateText ? stateText + '\n\n' : '') +
            'Este é um resumo do estado do projeto. Use-o como contexto.\n';

        try { await chrome.storage.local.set({ pendingPrompt: handoff }); }
        catch { /* ignore */ }

        const p = window.DS.getProvider();
        window.open(p.newChatUrl || (location.origin + '/'), '_blank');
        window.DS.panel.toast('🆕 Nova conversa aberta.');
    }

    window.DS.context = {
        composePrompt,
        deliverPrompt,
        setInputBig,
        handleAttach,
        handleApply,
        handleSelectContext,
        handleNewConversation,
        buildAndPasteSelection
    };
})();
