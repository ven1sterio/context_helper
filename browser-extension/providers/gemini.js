// Provider do Gemini (https://gemini.google.com) — captura via PÁGINA, sem API.
//
// Implementa a mesma interface de providers/deepseek.js. parser.js e content.js
// só falam com `window.DSProvider`, então trocar de site é trocar este arquivo.
//
// Estrutura da página (confirmada nos dumps de HTML do Gemini):
//   <user-query> ... </user-query>
//   <model-response> ... <message-content> <div class="markdown markdown-main-panel"> ... </div>
//   dentro do markdown: <p>, <h1..h6>, <ul>, <code-block> <pre><code data-test-id="code-content">
//   (parser.js lê `p`, `h*` e `pre`; `pre` existe dentro de <code-block>, então os
//   blocos `FILE:` / `EDIT:` são lidos pelo DOM exatamente como no DeepSeek.)
//
// Campo de texto: <rich-textarea><div class="ql-editor" contenteditable="true" role="textbox">
// (Quill). Textos grandes entram por um evento `paste` sintético — é muito mais
// rápido e confiável que execCommand('insertText') para centenas de KB.
//
// Tudo fica dentro de uma IIFE para não colidir com nomes globais de content.js
// (mesmo isolated world).

(function () {
    'use strict';

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // Ordem de preferência: o mais específico primeiro.
    const ASSISTANT_SELECTORS = [
        'model-response message-content .markdown',
        'model-response .markdown',
        'message-content .markdown',
        '.model-response-text .markdown',
        'model-response message-content'
    ];

    // Bloco de "raciocínio" (Mostrar raciocínio) não é a resposta final.
    const THINK_ANCESTOR_SELECTOR =
        'model-thoughts, thoughts-content, [class*="thoughts" i], [class*="thinking" i], [data-test-id*="thought" i]';

    const INPUT_SELECTORS = [
        'rich-textarea .ql-editor[contenteditable="true"]',
        '.ql-editor[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"][role="textbox"]',
        'rich-textarea [contenteditable="true"]',
        'textarea'
    ];

    const SEND_SELECTORS = [
        'button.send-button:not(.stop)',
        '.send-button-container button:not(.stop)',
        'button[aria-label*="Enviar mensagem" i]',
        'button[aria-label*="Send message" i]',
        'button[aria-label="Enviar" i]',
        'button[aria-label="Send" i]',
        '[data-test-id="send-button"]'
    ];

    const STOP_SELECTORS = [
        'button.send-button.stop',
        'button.stop',
        'button[aria-label*="Parar resposta" i]',
        'button[aria-label*="Interromper" i]',
        'button[aria-label*="Parar" i]',
        'button[aria-label*="Stop response" i]',
        'button[aria-label*="Stop generating" i]',
        'button[aria-label="Stop" i]',
        '[data-test-id="stop-button"]'
    ];

    const CONTINUE_BTN_RE = /^(?:[\s\p{So}\p{Sk}\p{Sm}]*)(?:continuar(?: a)?(?: gerar| gerando| gera[cç][aã]o)?|continue(?: generating| generation)?)\s*[.…]*$/iu;

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

    function isThinkNode(node) {
        return !!(node.closest && node.closest(THINK_ANCESTOR_SELECTOR));
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

    /** O Quill põe <p><br></p> quando vazio; normaliza para string vazia. */
    function normalizeEditorText(s) {
        return (s || '').replace(/​/g, '').replace(/\r\n/g, '\n');
    }

    class GeminiProvider {
        constructor() {
            this.name = 'Gemini';
            this.newChatUrl = 'https://gemini.google.com/app';
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
            return normalizeEditorText(input.innerText || input.textContent || '');
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
            // Limpa o conteúdo atual.
            try { document.execCommand('selectAll', false, null); } catch { /* ignore */ }
            try { document.execCommand('delete', false, null); } catch { /* ignore */ }

            // 1) Paste sintético (rápido, aceita textos grandes).
            let pasted = false;
            try {
                const dt = new DataTransfer();
                dt.setData('text/plain', text);
                const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
                input.dispatchEvent(ev);
                pasted = true;
            } catch { pasted = false; }

            // 2) Confere se entrou; senão tenta insertText.
            const expected = text.replace(/\s+/g, '').length;
            const got = () => this.readInput(input).replace(/\s+/g, '').length;
            if (!pasted || got() < expected * 0.9) {
                try {
                    document.execCommand('selectAll', false, null);
                    document.execCommand('insertText', false, text);
                } catch { /* ignore */ }
            }

            // 3) Último recurso: monta parágrafos e dispara `input`.
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

            try { input.scrollTop = input.scrollHeight; } catch { /* ignore */ }
        }

        findSendButton() {
            return firstVisible(SEND_SELECTORS);
        }

        async pressSend() {
            const input = this.findInput();
            if (!input) return false;
            input.focus();
            await sleep(150);

            // Após colar texto grande o botão pode demorar para habilitar.
            let btn = null;
            for (let i = 0; i < 40; i++) {
                btn = this.findSendButton();
                if (btn && !isDisabled(btn)) break;
                btn = null;
                await sleep(150);
            }

            if (btn) {
                btn.click();
            } else {
                // Fallback: Enter (no Gemini, Enter envia; Shift+Enter quebra linha).
                input.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                    bubbles: true, cancelable: true
                }));
            }

            // Sucesso = campo esvaziou OU a geração começou (botão virou "parar").
            for (let i = 0; i < 20; i++) {
                await sleep(150);
                if (this.readInput(input).trim().length === 0) return true;
                if (this.findStopButton()) return true;
            }
            return false;
        }

        listAssistantMessages() {
            for (const selector of ASSISTANT_SELECTORS) {
                let nodes;
                try { nodes = [...document.querySelectorAll(selector)]; } catch { continue; }
                if (nodes.length === 0) continue;
                const answers = nodes.filter(n => !isThinkNode(n));
                return answers.length > 0 ? answers : nodes;
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
            const tail = (text || '').slice(-400);
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
                if (!test || test.length > 40) continue;
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
        window.DSProvider = new GeminiProvider();
        window.DSProviderName = 'Gemini';
        window.ASSISTANT_SELECTORS = ASSISTANT_SELECTORS;
        window.isVisible = isVisible;
    } catch (e) {
        console.error('[Context Sync] falha ao criar provider do Gemini:', e);
    }
})();
