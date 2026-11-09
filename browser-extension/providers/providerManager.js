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
        maxInlineChars: 40000
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

    window.DS.getProvider = getProvider;
    window.DS.siteName = siteName;
    window.DS.listAssistantMessages = listAssistantMessages;
    window.DS.findLastAssistantMessage = findLastAssistantMessage;
    window.DS.messageText = messageText;
    window.DS.hasEndMarker = hasEndMarker;
    window.DS.readStatus = readStatus;
})();
