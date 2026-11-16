// Compõe prompts, anexa/cola no chat, pede contexto e aplica.
// Delega tudo ao provider — este arquivo não conhece DeepSeek/Gemini.
(function () {
    'use strict';
    window.DS = window.DS || {};
    const { sleep } = window.DS.protocol;
    const conn = window.DS.connection;

    // Nome do anexo quando há 1 parte: "contexto-projeto.txt".
    // Quando há N partes: "contexto-projeto-1-de-N.txt" … "contexto-projeto-N-de-N.txt".
    // O `N` é sempre o número REAL de repartições (não fixo em 2).
    const ATTACH_NAME = 'contexto-projeto.txt';
    const ATTACH_NAME_BASE = 'contexto-projeto';

    function attachNameFor(index, total) {
        if (total <= 1) return ATTACH_NAME;
        return `${ATTACH_NAME_BASE}-${index + 1}-de-${total}.txt`;
    }

    // Teto de partes por envio (evita 50 anexos num projeto gigante).
    const MAX_PARTS = 10;

    /**
     * Quebra o texto do contexto em pedaços BALANCEADOS (targetSize = total/N),
     * preferindo cortar no início de um bloco "--- arquivo ---". Cap em
     * MAX_PARTS: acima disso, trunca com aviso. Assim, um contexto de 100 KB
     * com maxChars=40 KB vira 3 partes de ~33 KB — não 2 cheias + 1 resíduo.
     */
    function splitContext(data, maxChars) {
        if (!data || data.length <= maxChars) return [data || ''];
        const minChunks = Math.ceil(data.length / maxChars);
        if (minChunks > MAX_PARTS) {
            const truncated = data.slice(0, maxChars * MAX_PARTS) +
                `\n\n[CONTEXTO TRUNCADO: ${data.length} chars excede ${MAX_PARTS} × ${maxChars}. ` +
                `Use "🎯 Seletivo" para focar em arquivos específicos.]\n`;
            return splitContext(truncated, maxChars);
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

    function headerFor(kind, index, total) {
        const part = total > 1 ? ` — parte ${index + 1} de ${total}` : '';
        return kind === 'full'
            ? `[CONTEXTO ATUAL DOS ARQUIVOS${part}]`
            : `[ATUALIZAÇÃO DO PROJETO — arquivos alterados/removidos${part}]`;
    }

    // Flags de reentrância: o usuário pode clicar duas vezes no botão.
    // Sem isso, duas chamadas concorrentes a handleAttach duplicam o prompt
    // no input do chat (bug observado com Gemini e ChatGPT).
    let busyAttach = false;
    let busyApply = false;
    let busySelect = false;

    function composePrompt(kind, { tree, data, question, fullCode }) {
        const p = window.DS.getProvider();
        const supportsFiles = !!(p.supportsFileAttach && p.attachTextFile);
        const maxChars = p.maxInlineChars || 40000;

        // Provider sem anexo (ou contexto vazio): cai no modo antigo (tudo inline).
        if (!supportsFiles || !data || data.length === 0) {
            const build = (ctx) => kind === 'full'
                ? buildFullPrompt({ tree, context: ctx, question, fullCode })
                : buildDeltaPrompt({ tree, changes: ctx, question, fullCode });
            return {
                text: build(data || ''),
                files: [],
                inline: (limit) => build(truncateAtFile(data || '', limit))
            };
        }

        // REGRAS ficam no TEXTO do chat (curto, estável).
        const rulesText = kind === 'full'
            ? buildRulesOnlyFull({ tree, question, fullCode })
            : buildRulesOnlyDelta({ tree, question, fullCode });

        // CONTEXTO vai em 1+ anexos .txt. Se precisar dividir, cada parte
        // ganha um cabeçalho "parte i de N".
        const chunks = splitContext(data, maxChars);
        const files = chunks.map((content, i) => ({
            name: attachNameFor(i, chunks.length),
            content: headerFor(kind, i, chunks.length) + '\n' + content
        }));

        // Aviso no texto do chat apontando para o(s) anexo(s).
        const attachNote = files.length === 1
            ? `(O conteúdo dos arquivos está no ANEXO "${files[0].name}" desta mensagem. ` +
              `Leia-o inteiro antes de responder; os caminhos e o formato das respostas seguem as regras acima.)`
            : `(O conteúdo dos arquivos está nos ${files.length} ANEXOS ` +
              `"${files[0].name}" a "${files[files.length - 1].name}" desta mensagem. ` +
              `Leia TODOS, na ordem, antes de responder; os caminhos e o formato das respostas seguem as regras acima.)`;

        return {
            text: rulesText + '\n\n' + attachNote,
            files,
            // Fallback (algum anexo falhou): cola inline truncado no limite do provider.
            inline: (limit) => (kind === 'full'
                ? buildFullPrompt({ tree, context: truncateAtFile(data, limit), question, fullCode })
                : buildDeltaPrompt({ tree, changes: truncateAtFile(data, limit), question, fullCode }))
        };
    }

    /** Corta `data` no limite, preferindo o início de um bloco "--- arquivo ---". */
    function truncateAtFile(data, limit) {
        if (!limit || !data || data.length <= limit) return data;
        let cut = data.lastIndexOf('\n--- ', limit);
        if (cut < limit / 2) cut = limit;
        return data.slice(0, cut) +
            '\n\n[CONTEXTO TRUNCADO: o projeto é grande demais para colar no campo. ' +
            'Peça os arquivos que faltam pelo nome ou use o botão \"🎯 Seletivo\".]\n';
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

        // Sem anexos: cola o texto direto (provider sem suporte a arquivo).
        if (!composed.files || composed.files.length === 0) {
            await setInputBig(input, composed.text);
            return { attached: false };
        }

        // Já existe algum chip nosso no campo? Pede para remover antes de duplicar.
        // (hasAttachmentChip usa o "stem" do nome — pega qualquer parte do split.)
        for (const f of composed.files) {
            if (p.hasAttachmentChip && p.hasAttachmentChip(f.name)) {
                window.DS.panel.toast(`⚠️ Já existe um anexo "${f.name}" no campo. ` +
                    'Remova-o (×) ou envie a mensagem antes de anexar de novo.');
                return { attached: false, aborted: true };
            }
        }

        window.DS.panel.toast(composed.files.length === 1
            ? `📎 Anexando "${composed.files[0].name}"...`
            : `📎 Anexando ${composed.files.length} partes do contexto...`);

        // Cola as regras (texto curto) no campo e anexa os pedaços em sequência.
        await setInputBig(input, composed.text);
        await sleep(400);

        let currentInput = p.findInput() || input;
        for (let i = 0; i < composed.files.length; i++) {
            const f = composed.files[i];
            const ok = await p.attachTextFile(currentInput, f.content, f.name);
            if (!ok) {
                // O upload pode terminar depois do timeout: confere de novo.
                await sleep(3000);
                if (!(p.hasAttachmentChip && p.hasAttachmentChip(f.name))) {
                        // ABORTA em vez de colar inline: se as partes 1..i-1 já estão
                        // anexadas, colar o texto inteiro inline DUPLICARIA o contexto.
                        window.DS.panel.toast(
                            `⚠️ Falha ao anexar "${f.name}" (parte ${i + 1}/${composed.files.length}). ` +
                            `Remova os anexos já feitos e tente de novo, ou use "🎯 Seletivo".`);
                        return { attached: false, aborted: true };
                }
            }
            // Pequeno intervalo para o editor processar cada upload.
            if (i < composed.files.length - 1) await sleep(500);
            // O DOM pode ter re-renderizado após o paste: busca o input de novo.
            currentInput = p.findInput() || currentInput;
        }

        return { attached: true };
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

        // Este chat já recebeu o contexto completo (ex.: antes do F5)? Reenviar duplica tudo.
        if (mode === 'full' && conn.nextIsDelta &&
            !confirm('Este chat já recebeu o contexto completo do projeto.\n\n' +
                'Enviar de novo DUPLICA o conteúdo e aumenta o risco de "Content is too long".\n\n' +
                'Use "📎 Anexar alterações" para enviar só o que mudou. Enviar o contexto completo mesmo assim?')) {
            return;
        }

        busyAttach = true;
        try {
            window.DS.panel.toast('Buscando contexto...');
            const msg = await conn.requestContext(mode);
            if (!msg) { window.DS.panel.toast('Sem resposta do VS Code.'); return; }
            if (msg.mode === 'empty') { window.DS.panel.toast('Nenhuma alteração desde o último envio.'); return; }

            const kb = (msg.chars / 1024).toFixed(1);

            if (msg.mode === 'full') {
                const r = await deliverPrompt(input, composePrompt('full', { tree: msg.tree, data: msg.data, question, fullCode: false }));
                if (r.aborted) return;
                conn.nextIsDelta = true;
                let info = `Contexto completo: ${msg.files} arquivo(s), ${kb} KB.`;
                if (msg.omitted > 0) info += ` ${msg.omitted} omitido(s) por limite de tamanho.`;
                window.DS.panel.toast(info);
            } else {
                const r = await deliverPrompt(input, composePrompt('delta', { tree: msg.tree, data: msg.data, question, fullCode: false }));
                if (r.aborted) return;
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

        const delivered = await deliverPrompt(input, composePrompt('full', { tree: res.tree, data: res.data, question, fullCode: false }));
        if (delivered.aborted) return;
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
