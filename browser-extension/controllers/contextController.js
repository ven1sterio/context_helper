// Compõe prompts, anexa/cola no chat, pede contexto e aplica.
// Delega tudo ao provider — este arquivo não conhece DeepSeek/Gemini.
(function () {
    'use strict';
    window.DS = window.DS || {};
    const { sleep } = window.DS.protocol;
    const conn = window.DS.connection;

    const ATTACH_NOTE = '(O conteúdo dos arquivos está no ANEXO "contexto-projeto.txt" desta mensagem. ' +
        'Leia-o inteiro antes de responder; os caminhos e o formato das respostas seguem as regras acima.)';

    // Flags de reentrância: o usuário pode clicar duas vezes no botão.
    // Sem isso, duas chamadas concorrentes a handleAttach duplicam o prompt
    // no input do chat (bug observado com Gemini e ChatGPT).
    let busyAttach = false;
    let busyApply = false;
    let busySelect = false;

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
        // Sempre usa setInputChunked quando disponível: é assíncrono e tem
        // delay entre chunks, o que evita o bug de "colar 2×" quando o editor
        // (Quill/ProseMirror) processa o `paste` de forma assíncrona e um
        // segundo insertText síncrono duplicaria o conteúdo.
        if (p.setInputChunked) {
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
            await setInputBig(input, composed.text);
            await sleep(400); // deixa o editor processar antes de anexar
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
        if (busyAttach) {
            window.DS.panel.toast('Já há um contexto sendo anexado. Aguarde.');
            return;
        }
        if (busyApply) {
            window.DS.panel.toast('Aguarde a aplicação atual terminar.');
            return;
        }
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

        busyAttach = true;
        try {
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
        } finally {
            busyAttach = false;
        }
    }

    async function handleApply() {
        if (busyApply) {
            window.DS.panel.toast('Já há uma aplicação em andamento.');
            return;
        }
        if (busyAttach) {
            window.DS.panel.toast('Aguarde o contexto terminar de ser anexado.');
            return;
        }
        const state = window.DS.agentState;
        if (state.state === window.DS.STATES.RUNNING || state.state === window.DS.STATES.APPLYING) {
            window.DS.panel.toast('Aguarde o agente terminar.');
            return;
        }
        if (!conn.isOpen()) { window.DS.panel.toast('Sem conexão com o VS Code.'); return; }

        // Engenharia reversa (modo manual): executa os "### RE:" da última resposta e cola o
        // resultado no campo de entrada para você enviar ao chat.
        {
            const pr = window.DS.getProvider();
            const node = pr.findLastAssistantMessage();
            const re = node ? scanReRequests(pr.messageText(node)) : { requests: [], errors: [] };
            if (re.requests.length || re.errors.length) {
                const input = pr.findInput();
                if (!input) { window.DS.panel.toast('Campo de entrada não encontrado.'); return; }
                busyApply = true;
                try {
                    let text = '';
                    if (re.requests.length) {
                        window.DS.panel.toast(`🔬 Engenharia reversa: ${re.requests.length} pedido(s)... (a 1ª análise de uma DLL pode demorar)`);
                        const rr = await conn.requestRE(re.requests);
                        text = (rr && rr.text) || '(sem resposta do VS Code)';
                    }
                    await setInputBig(input, buildReResultPrompt({ text, errors: re.errors, ignoredFiles: false }));
                    window.DS.panel.toast('🔬 Resultado colado no campo. Revise e envie.');
                } finally {
                    busyApply = false;
                }
                return;
            }
        }

        const result = parseLastResponse();
        if (result.error) { window.DS.panel.toast(result.error); return; }
        if (result.problems.length > 0) {
            alert('O modelo não seguiu o contrato:\n\n' + result.problems.join('\n') + '\n\nNada será aplicado.');
            return;
        }

        busyApply = true;
        try {
            window.DS.panel.toast(`Aguardando confirmação no VS Code (${result.files.length} bloco(s))...`);
            const res = await conn.applyFilesManual(result.files);
            if (res && res.type === 'applyResult') {
                const icon = res.status === 'applied' ? '✅' : res.status === 'cancelled' ? '⏹' : '❌';
                window.DS.panel.toast(`${icon} ${res.message || res.status}`);
            }
        } finally {
            busyApply = false;
        }
    }

    async function handleSelectContext() {
        if (busySelect) {
            window.DS.panel.toast('Já há uma seleção em andamento.');
            return;
        }
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

        busySelect = true;
        try {
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
        } finally {
            busySelect = false;
        }
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
