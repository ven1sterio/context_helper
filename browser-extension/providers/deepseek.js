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
    constructor() {
        this.name = 'DeepSeek';
        this.newChatUrl = 'https://chat.deepseek.com/';
        // Mesmo tratamento do Gemini: acima deste tamanho o contexto vai como
        // ARQUIVO anexo — colar centenas de KB no campo do chat trava a aba.
        this.maxInlineChars = 40000;
        this.supportsFileAttach = true;
    }

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

    /** Há um chip/preview de anexo mostrando esse nome de arquivo? */
    hasAttachmentChip(name) {
        const input = this.findInput();
        const nodes = document.querySelectorAll(
            '[class*="file" i], [class*="upload" i], [class*="attach" i], [class*="preview" i]'
        );
        for (const n of nodes) {
            // Ignora o próprio campo e seus descendentes: o texto do prompt
            // (ATTACH_NOTE) menciona o filename e daria falso positivo.
            if (input && (n === input || input.contains(n) || n.contains(input))) continue;
            const txt = (n.textContent || '').trim();
            if (txt.length > 200) continue; // chip é pequeno (nome + tamanho)
            if (txt.includes(name) && isVisible(n)) return true;
        }
        return false;
    }

    /**
     * Cola o texto como ARQUIVO .txt no chat (mesmo tratamento do Gemini).
     * Tenta paste com File e, se o site ignorar, drop com File. Devolve true
     * só se o chip do anexo aparecer — senão o chamador cai no inline fatiado.
     */
    async attachTextFile(input, text, filename) {
        if (!input) return false;
        let file;
        try { file = new File([text], filename, { type: 'text/plain' }); } catch { return false; }

        const waitChip = async (ms) => {
            const end = Date.now() + ms;
            while (Date.now() < end) {
                if (this.hasAttachmentChip(filename)) return true;
                await providerSleep(250);
            }
            return false;
        };

        // 1) paste com File
        try {
            input.focus();
            const dt = new DataTransfer();
            dt.items.add(file);
            input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
            if (await waitChip(6000)) return true;
        } catch { /* tenta o drop */ }

        // 2) drop com File na área de entrada
        try {
            const target = input.closest('form') || input.parentElement || input;
            const dt = new DataTransfer();
            dt.items.add(file);
            for (const type of ['dragenter', 'dragover', 'drop']) {
                target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
            }
            if (await waitChip(6000)) return true;
        } catch { /* ignore */ }
        return false;
    }

    /**
     * Cola texto grande em pedaços (fallback se o anexo falhar). Para <textarea>
     * o setValue direto já é O(n); só fatiamos contenteditable.
     */
    async setInputChunked(input, text, onProgress) {
        if (!input) return false;
        if (input.tagName === 'TEXTAREA') { this.setInput(input, text); return true; }
        input.focus();
        try { document.execCommand('selectAll', false, null); } catch { /* ignore */ }
        try { document.execCommand('delete', false, null); } catch { /* ignore */ }
        await providerSleep(50);

        const CHUNK = 12000;
        let pos = 0;
        while (pos < text.length) {
            let end = Math.min(text.length, pos + CHUNK);
            if (end < text.length) {
                const nl = text.lastIndexOf('\n', end);
                if (nl > pos + CHUNK / 2) end = nl + 1;
            }
            const piece = text.slice(pos, end);
            try {
                const dt = new DataTransfer();
                dt.setData('text/plain', piece);
                input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
            } catch {
                try { document.execCommand('insertText', false, piece); } catch { /* ignore */ }
            }
            pos = end;
            if (onProgress) onProgress(Math.min(100, Math.round(pos / text.length * 100)));
            await providerSleep(40);
        }
        const expected = text.replace(/\s+/g, '').length;
        const got = (input.textContent || input.value || '').replace(/\s+/g, '').length;
        return got >= expected * 0.9;
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
        window.DSProviderName = 'DeepSeek';
        window.ASSISTANT_SELECTORS = ASSISTANT_SELECTORS;
        window.isVisible = isVisible;
    } catch (e) {
        console.error('[DeepSeek Sync] falha ao criar provider:', e);
    }
})();
