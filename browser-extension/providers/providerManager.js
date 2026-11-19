// Descoberta de provider + helpers de site. Carregado ANTES do provider específico.
(function () {
    'use strict';
    window.DS = window.DS || {};

    const FALLBACK = {
        findInput: () => document.querySelector('#chat-input') || document.querySelector('textarea') || document.querySelector('[contenteditable="true"]'),
        readInput: (i) => i && i.tagName === 'TEXTAREA' ? i.value : (i ? (i.innerText || '') : ''),
        setInput: (i, t) => {
            if (!i) return;
            if (i.tagName === 'TEXTAREA') { i.value = t; i.dispatchEvent(new Event('input', { bubbles: true })); }
            else { i.focus(); document.execCommand('selectAll'); document.execCommand('insertText', false, t); }
        },
        pressSend: async () => false,
        snapshotAssistant: () => ({ count: 0, last: null }),
        findStopButton: () => null,
        findContinueButton: () => null,
        listAssistantMessages: () => [],
        findLastAssistantMessage: () => null,
        messageText: () => '',
        hasEndMarker: () => false,
        readStatus: () => null,
        newChatUrl: null,
        supportsFileAttach: false,
        maxInlineChars: 40000,
        maxContextChars: 150000,
        maxAttachChars: 250000,
        maxMessageChars: 2500000,
        maxFilesPerMessage: 10
    };

    function getProvider() {
        return window.DSProvider || FALLBACK;
    }

    function siteName() {
        return window.DSProviderName || 'DeepSeek';
    }

    function listAssistantMessages() {
        const p = getProvider();
        return p.listAssistantMessages ? p.listAssistantMessages() : [];
    }

    function findLastAssistantMessage() {
        const p = getProvider();
        return p.findLastAssistantMessage ? p.findLastAssistantMessage() : null;
    }

    function messageText(node) {
        const p = getProvider();
        return p.messageText ? p.messageText(node) : (node ? (node.innerText || node.textContent || '') : '');
    }

    function hasEndMarker(text) {
        const p = getProvider();
        if (p.hasEndMarker) return p.hasEndMarker(text);
        const marker = typeof END_MARKER !== 'undefined' ? END_MARKER : '[[FIM-DA-RESPOSTA]]';
        return (text || '').trim().slice(-120).includes(marker);
    }

    function readStatus(text) {
        const p = getProvider();
        if (p.readStatus) return p.readStatus(text);
        const tail = (text || '').slice(-1000);
        const re = /\[\[\s*STATUS\s*:\s*(CONTINUAR|CONCLU[IÍ]DO)\s*\]\]/gi;
        let last = null, m;
        while ((m = re.exec(tail)) !== null) last = m[1].toUpperCase();
        if (!last) return null;
        return last === 'CONTINUAR' ? 'continue' : 'done';
    }


    // ---------------------------------------------------------------------
    // Anexo de arquivo (compartilhado pelos 3 provedores).
    //
    // BUG corrigido: antes cada provedor fazia "paste com File", esperava 6s por um
    // chip detectado por NOME DE CLASSE CSS e, se não achasse (classes hashadas do
    // DeepSeek/ChatGPT), fazia "drop" também → o arquivo era anexado 2x ("contexto
    // duplicado") e, em seguida, o texto inteiro era colado inline ("Content is too
    // long"). Agora: detecta o chip pelo TEXTO (nome do arquivo), por diferença
    // contra o que já existia, tenta UM método por vez e nunca anexa duas vezes.
    // ---------------------------------------------------------------------
    function _stemOf(name) { return String(name).slice(0, 10); }
    // Stem do nome completo (sem extensão). Distingue partes de split:
    // "contexto-projeto-1-de-3.txt" ≠ "contexto-projeto-2-de-3.txt".
    function _exactStemOf(name) { return String(name).replace(/\.[^.]+$/, ''); }

    /**
     * Área que contém o CAMPO e os CHIPS de anexo — NÃO a conversa inteira.
     *
     * Sem esse escopo, `countFileChips` acha chips de mensagens antigas e:
     *   - bloqueia re-anexar contexto ("já existe anexo no campo");
     *   - confunde parts do split (stem `contexto-p` casa com tudo).
     *
     * Usamos, em ordem: <form> ancestral, ou 3 níveis acima do campo (composer).
     */
    function findChipScope(input) {
        if (!input) return document.body;
        const form = input.closest('form');
        if (form) return form;
        let el = input;
        for (let i = 0; i < 3 && el.parentElement; i++) el = el.parentElement;
        return el;
    }

    function _walkCount(root, input, needle) {
        if (!needle) return 0;
        let n = 0;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        let node;
        while ((node = walker.nextNode())) {
            const t = node.nodeValue;
            if (!t || t.length > 200 || t.indexOf(needle) === -1) continue;
            const el = node.parentElement;
            if (!el) continue;
            if (el.closest('#ds-sync-root')) continue;
            if (input && (el === input || input.contains(el))) continue;
            if (el.closest('script, style, noscript')) continue;
            n++;
        }
        return n;
    }

    /**
     * Conta chips pelo prefixo (10 chars). Usado pelo `attachFileOnce` para
     * detectar "apareceu UM chip novo?" — funciona mesmo se o site truncar
     * o nome exibido.
     */
    function countFileChips(name, input) {
        return _walkCount(findChipScope(input), input, _stemOf(name));
    }

    /**
     * Conta chips pelo NOME COMPLETO (sem extensão). Distingue parts do split:
     * parte 1 (`contexto-projeto-1-de-3`) não casa com parte 2 (`-2-de-3`).
     * Usado por `hasAttachmentChip` para o "já existe?".
     */
    function countFileChipsExact(name, input) {
        return _walkCount(findChipScope(input), input, _exactStemOf(name));
    }

    async function _waitChipDelta(name, input, baseline, ms) {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            if (countFileChips(name, input) > baseline) return true;
            await new Promise(r => setTimeout(r, 300));
        }
        return false;
    }

    /**
     * Anexa `text` como arquivo no chat. `dropTargetFn(input)` devolve o alvo do drop.
     * Retorna true somente se UM novo chip apareceu. Nunca tenta o 2º método enquanto
     * o 1º ainda pode estar processando (espera até 15s por upload lento).
     */
    async function attachFileOnce(input, text, filename, dropTargetFn) {
        if (!input) return false;
        let file;
        try { file = new File([text], filename, { type: 'text/plain' }); } catch { return false; }
        const baseline = countFileChips(filename, input);

        // 1) paste com File
        try {
            input.focus();
            const dt = new DataTransfer();
            dt.items.add(file);
            input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
            if (await _waitChipDelta(filename, input, baseline, 15000)) return true;
        } catch { /* cai no drop */ }

        // 2) drop — só se NADA apareceu depois de 15s
        try {
            const target = (dropTargetFn && dropTargetFn(input)) || input.parentElement || input;
            const dt = new DataTransfer();
            dt.items.add(file);
            for (const type of ['dragenter', 'dragover', 'drop']) {
                target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
            }
            if (await _waitChipDelta(filename, input, baseline, 15000)) return true;
        } catch { /* ignore */ }
        return false;
    }

    /** Há aviso de "conteúdo longo demais" visível na página? */
    const TOO_LONG_RE = /content is too long|too long|conte[uú]do (?:\u00e9 )?(?:muito )?longo|mensagem (?:\u00e9 )?muito longa|内容过长|输入内容过长/i;
    function findTooLongNotice() {
        const els = document.querySelectorAll('[role="alert"], [class*="toast" i], [class*="message" i], [class*="notice" i], [class*="error" i]');
        for (const el of els) {
            if (el.closest('#ds-sync-root')) continue;
            const t = (el.innerText || el.textContent || '').trim();
            if (t && t.length < 200 && TOO_LONG_RE.test(t)) return t;
        }
        return null;
    }

    window.DS.countFileChips = countFileChips;
    window.DS.countFileChipsExact = countFileChipsExact;
    window.DS.findChipScope = findChipScope;
    window.DS.attachFileOnce = attachFileOnce;
    window.DS.findTooLongNotice = findTooLongNotice;

    window.DS.getProvider = getProvider;
    window.DS.siteName = siteName;
    window.DS.listAssistantMessages = listAssistantMessages;
    window.DS.findLastAssistantMessage = findLastAssistantMessage;
    window.DS.messageText = messageText;
    window.DS.hasEndMarker = hasEndMarker;
    window.DS.readStatus = readStatus;
})();
