// Provider do ChatGPT (https://chatgpt.com e https://chat.openai.com)
// Implementa a mesma interface de providers/deepseek.js.

(function () {
    'use strict';

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    const ASSISTANT_SELECTORS = [
        '[data-message-author-role="assistant"] .markdown',
        '[data-message-author-role="assistant"]'
    ];

    const INPUT_SELECTORS = [
        '#prompt-textarea',
        'textarea[data-id="root"]',
        'div[contenteditable="true"][role="textbox"]'
    ];

    const SEND_SELECTORS = [
        'button[data-testid="send-button"]',
        'button[aria-label*="Send" i]',
        'button[aria-label*="Enviar" i]'
    ];

    const STOP_SELECTORS = [
        'button[data-testid="stop-button"]',
        'button[aria-label*="Stop" i]',
        'button[aria-label*="Parar" i]'
    ];

    // Regex para o botão "Continue generating" / "Continuar gerando"
    const CONTINUE_BTN_RE = /^(?:[\s\p{So}\p{Sk}\p{Sm}]*)(?:continue generating|continuar(?: a)?(?: gerar| gerando| gera[cç][aã]o)?)\s*[.…]*$/iu;

    function isVisible(el) {
        if (!el || !el.getClientRects) return false;
        const rects = el.getClientRects();
        if (!rects || rects.length === 0) return false;
        const rect = rects[0];
        if (rect.width === 0 && rect.height === 0) return false;
        const style = window.getComputedStyle(el);
        if (!style) return false;
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        if (parseFloat(style.opacity) === 0) return false;
        return true;
    }

    function firstVisible(selectors) {
        for (const sel of selectors) {
            let nodes;
            try { nodes = document.querySelectorAll(sel); } catch { continue; }
            for (const el of nodes) if (isVisible(el)) return el;
        }
        return null;
    }

    function isDisabled(btn) {
        if (!btn) return true;
        if (btn.disabled) return true;
        const aria = btn.getAttribute('aria-disabled');
        return aria === 'true';
    }

    class ChatGPTProvider {
        constructor() {
            this.name = 'ChatGPT';
            this.newChatUrl = 'https://chatgpt.com/';
            this.maxInlineChars = 40000;
            this.supportsFileAttach = false; // Simplificado: cola direto no texto (ou podemos tentar o chunked)
        }

        isInputEmpty(input) {
            if (!input) return true;
            if (input.tagName === 'TEXTAREA') return input.value.trim().length === 0;
            return (input.textContent || '').replace(/[\u200B\s]/g, '').length === 0;
        }

        findInput() {
            for (const sel of INPUT_SELECTORS) {
                let el;
                try { el = document.querySelector(sel); } catch { continue; }
                if (el) return el;
            }
            return null;
        }

        readInput(input) {
            if (!input) return '';
            if (input.tagName === 'TEXTAREA') return input.value;
            return (input.innerText || input.textContent || '').replace(/\u200B/g, '').replace(/\r\n/g, '\n');
        }

        setInput(input, text) {
            if (!input) return;
            if (input.tagName === 'TEXTAREA') {
                const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
                setter.call(input, text);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.focus();
                return;
            }

            input.focus();
            try { document.execCommand('selectAll', false, null); } catch { /* ignore */ }
            try { document.execCommand('delete', false, null); } catch { /* ignore */ }

            // Tenta colar via evento sintético (rápido para textos grandes no ProseMirror)
            let pasted = false;
            try {
                const dt = new DataTransfer();
                dt.setData('text/plain', text);
                const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
                input.dispatchEvent(ev);
                pasted = true;
            } catch { pasted = false; }

            const expected = text.replace(/\s+/g, '').length;
            const got = () => (input.textContent || '').replace(/\s+/g, '').length;

            if (!pasted || got() < expected * 0.9) {
                try {
                    document.execCommand('selectAll', false, null);
                    document.execCommand('insertText', false, text);
                } catch { /* ignore */ }
            }
            
            // Fallback final: monta parágrafos
            if (got() < expected * 0.9) {
                input.textContent = '';
                const frag = document.createDocumentFragment();
                for (const line of text.split('\n')) {
                    const p = document.createElement('p');
                    if (line.length === 0) p.appendChild(document.createElement('br'));
                    else p.textContent = line;
                    frag.appendChild(p);
                }
                input.appendChild(frag);
                input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
            }
        }

        async setInputChunked(input, text, onProgress) {
            // ChatGPT geralmente aguenta colar direto, mas mantemos a interface
            this.setInput(input, text);
            return true;
        }

        findSendButton() {
            return firstVisible(SEND_SELECTORS);
        }

        async pressSend(waitMs) {
            const input = this.findInput();
            if (!input) return false;
            input.focus();
            await sleep(150);

            const tries = Math.max(40, Math.ceil((waitMs || 6000) / 150));
            let btn = null;
            for (let i = 0; i < tries; i++) {
                btn = this.findSendButton();
                if (btn && !isDisabled(btn)) break;
                btn = null;
                await sleep(150);
            }

            if (btn) {
                btn.click();
            } else {
                input.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                    bubbles: true, cancelable: true
                }));
            }

            for (let i = 0; i < 40; i++) {
                await sleep(150);
                if (this.isInputEmpty(input)) return true;
                if (this.findStopButton()) return true;
            }
            return false;
        }

        listAssistantMessages() {
            for (const selector of ASSISTANT_SELECTORS) {
                let nodes;
                try { nodes = [...document.querySelectorAll(selector)]; } catch { continue; }
                if (nodes.length > 0) return nodes;
            }
            return [];
        }

        findLastAssistantMessage() {
            const nodes = this.listAssistantMessages();
            return nodes.length > 0 ? nodes[nodes.length - 1] : null;
        }

        messageText(node) {
            return node ? (node.innerText || node.textContent || '') : '';
        }

        hasEndMarker(text) {
            const marker = typeof END_MARKER !== 'undefined' ? END_MARKER : '[[FIM-DA-RESPOSTA]]';
            const tail = (text || '').trim().slice(-120);
            return tail.includes(marker);
        }

        readStatus(text) {
            const tail = (text || '').slice(-1000);
            const re = /\[\[\s*STATUS\s*:\s*(CONTINUAR|CONCLU[IÍ]DO)\s*\]\]/gi;
            let last = null, m;
            while ((m = re.exec(tail)) !== null) last = m[1].toUpperCase();
            if (!last) return null;
            return last === 'CONTINUAR' ? 'continue' : 'done';
        }

        findStopButton() {
            return firstVisible(STOP_SELECTORS);
        }

        findContinueButton() {
            const candidates = document.querySelectorAll('button, [role="button"]');
            for (const el of candidates) {
                const text = (el.innerText || el.textContent || '').trim();
                const aria = (el.getAttribute('aria-label') || '').trim();
                const test = (text || aria).trim();
                if (!test || test.length > 45) continue;
                if (CONTINUE_BTN_RE.test(test) && isVisible(el)) return el;
            }
            return null;
        }

        snapshotAssistant() {
            const nodes = this.listAssistantMessages();
            return { count: nodes.length, last: nodes[nodes.length - 1] || null };
        }

        isVisible(el) { return isVisible(el); }
    }

    try {
        window.DSProvider = new ChatGPTProvider();
        window.DSProviderName = 'ChatGPT';
        window.ASSISTANT_SELECTORS = ASSISTANT_SELECTORS;
        window.isVisible = isVisible;
    } catch (e) {
        console.error('[Context Sync] falha ao criar provider do ChatGPT:', e);
    }
})();
