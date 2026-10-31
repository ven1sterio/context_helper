// Adaptador de provedor (Fase 6).
//
// Isola o "conhecimento do site" (seletores CSS, forma de enviar/ler resposta,
// detecção de fim, botão "Continuar", botão "Parar") atrás de uma interface
// estável. `parser.js` e `content.js` chamam apenas os métodos abaixo — trocar
// de provedor é implementar a mesma interface.
//
// Interface `Provider`:
//   findInput()                            -> HTMLElement | null
//   readInput(input)                       -> string
//   setInput(input, text)                  -> void
//   pressSend()                            -> Promise<boolean>
//   listAssistantMessages()                -> HTMLElement[]
//   findLastAssistantMessage()             -> HTMLElement | null
//   messageText(node)                      -> string
//   hasEndMarker(text)                     -> boolean
//   readStatus(text)                       -> 'continue' | 'done' | null
//   findStopButton()                       -> HTMLElement | null
//   findContinueButton()                   -> HTMLElement | null
//   snapshotAssistant()                    -> { count, last }
//   isVisible(el)                          -> boolean

const ASSISTANT_SELECTORS = [
    '.ds-markdown',
    '[data-message-author-role="assistant"]',
    '.markdown'
];

// O bloco de "raciocínio" (DeepThink) também usa .ds-markdown; não é a resposta final.
const THINK_ANCESTOR_SELECTOR = '[class*="ds-think" i], [class*="think-content" i], [class*="thinking" i]';

const CONTINUE_BTN_RE = /^(?:[\s\p{So}\p{Sk}\p{Sm}]*)(?:continuar(?: a)?(?: gerar| gerando| gera[cç][aã]o)?|continue(?: generating| generation)?|继续生成|继续)\s*[:：]?\s*(?:\(\d+\s*(?:\/\s*\d+)?\)|\[\d+(?:\s*\/\s*\d+)?\]|\d+\s*\/\s*\d+)?\s*[.…]*$/iu;

function isThinkNode(node) {
    return !!(node.closest && node.closest(THINK_ANCESTOR_SELECTOR));
}

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

// NOTA: este arquivo roda no MESMO isolated world que content.js (mesmo
// content_scripts entry). Como todos compartilham o escopo global, NÃO use
// `const sleep` aqui — colidiria com o `const sleep` de content.js e geraria
// SyntaxError, derrubando o content.js inteiro (painel/FAB nunca apareceria).
const providerSleep = ms => new Promise(r => setTimeout(r, ms));

class DeepSeekProvider {
    findInput() {
        return document.querySelector('#chat-input')
            || document.querySelector('textarea')
            || document.querySelector('[contenteditable="true"]');
    }

    readInput(input) {
        return input.tagName === 'TEXTAREA' ? input.value : (input.innerText || '');
    }

    setInput(input, text) {
        if (input.tagName === 'TEXTAREA') {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
            setter.call(input, text);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.focus();
            input.setSelectionRange(text.length, text.length);
            input.scrollTop = input.scrollHeight;
        } else {
            input.focus();
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, text);
        }
    }

    async pressSend() {
        const input = this.findInput();
        if (!input) return false;
        input.focus();
        await providerSleep(100);
        input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
            bubbles: true, cancelable: true
        }));
        await providerSleep(300);
        if (this.readInput(input).trim().length > 0) {
            const sendBtn = document.querySelector(
                '[data-testid="send-button"], ' +
                'button[aria-label*="Send" i], ' +
                'button[aria-label*="Enviar" i], ' +
                'div[role="button"][aria-label*="Send" i]'
            );
            if (sendBtn) { sendBtn.click(); await providerSleep(300); }
        }
        return this.readInput(input).trim().length === 0;
    }

    listAssistantMessages() {
        for (const selector of ASSISTANT_SELECTORS) {
            const nodes = [...document.querySelectorAll(selector)];
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
        // END_MARKER vive no escopo lexical compartilhado (prompt.js), não em window.
        // O typeof protege caso o arquivo ainda não tenha rodado.
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
        const candidates = document.querySelectorAll(
            '[data-testid="stop-button"], ' +
            'button[aria-label*="Stop" i], button[aria-label*="Parar" i], ' +
            '[role="button"][aria-label*="Stop" i], [role="button"][aria-label*="Parar" i], ' +
            'button[title*="Stop" i], button[title*="Parar" i]'
        );
        for (const el of candidates) if (isVisible(el)) return el;
        return null;
    }

    findContinueButton() {
        const candidates = document.querySelectorAll('button, [role="button"], div[class*="btn" i], span[class*="btn" i]');
        const matched = [];
        for (const el of candidates) {
            const text = (el.innerText || el.textContent || '').trim();
            const aria = (el.getAttribute('aria-label') || '').trim();
            const test = (text || aria).trim();
            if (!test || test.length > 40) continue;
            if (CONTINUE_BTN_RE.test(test) && isVisible(el)) matched.push({ el, test });
        }
        return matched.length > 0 ? matched[0].el : null;
    }

    snapshotAssistant() {
        const nodes = this.listAssistantMessages();
        return { count: nodes.length, last: nodes[nodes.length - 1] || null };
    }

    isVisible(el) { return isVisible(el); }
}

// Expõe no window para parser.js e content.js (carregados depois).
(function () {
    try {
        window.DSProvider = new DeepSeekProvider();
        window.ASSISTANT_SELECTORS = ASSISTANT_SELECTORS;
        window.isVisible = isVisible;
    } catch (e) {
        console.error('[DeepSeek Sync] falha ao criar provider:', e);
    }
})();
