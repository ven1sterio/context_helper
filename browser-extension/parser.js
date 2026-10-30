// Extração dos arquivos (### FILE:) e edições (EDIT:) da última resposta.
// Delega para window.DSProvider (providers/deepseek.js) quando disponível.

const PLACEHOLDER_PATH = 'caminho/do/arquivo.ext';
const FILE_MARKER_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*)?FILE\s*:\s*(.+?)\s*$/i;
const EDIT_MARKER_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*)?EDIT\s*:\s*(.+?)\s*$/i;

const EDIT_BLOCK_RE = /<{7}[ \t]*(?:SEARCH[^\n]*)?\r?\n([\s\S]*?)\r?\n[ \t]*={7}[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*>{7}[ \t]*(?:REPLACE[^\n]*)?/g;

const ELLIPSIS_LINE_RE = /^\s*(?:(?:\/\/|#|\/\*+|<!--|--|;)\s*)?(?:\.{3}|…)\s*(?:\*+\/|-->)?\s*$/m;
const PLACEHOLDER_LINE_RE = /^\s*(?:\/\/|#|\/\*+|<!--|<|--)\s*(?:\.{3}|…)?\s*(?:resto do c[oó]digo|restante do c[oó]digo|rest of (?:the )?(?:code|file|function|class)|remaining code|existing code|unchanged code|c[oó]digo (?:existente|anterior|original|omitido|inalterado))/im;
const DIFF_MARKER_RE = /^(?:@@ .+ @@|\+\+\+ [ab]\/|--- [ab]\/)/m;

function getProvider() {
    if (window.DSProvider) return window.DSProvider;
    // Fallback mínimo: se providers/deepseek.js não carregou, ainda funciona para o básico.
    return {
        listAssistantMessages() {
            const selectors = ['ds-markdown', 'markdown'];
            const out = [];
            for (const cls of selectors) {
                const nodes = document.querySelectorAll('.' + cls);
                for (const n of nodes) out.push(n);
            }
            return out;
        },
        findLastAssistantMessage() {
            const nodes = this.listAssistantMessages();
            return nodes.length > 0 ? nodes[nodes.length - 1] : null;
        },
        messageText(node) { return node ? (node.innerText || node.textContent || '') : ''; },
        hasEndMarker(text) { return (text || '').trim().slice(-120).includes(END_MARKER); },
        readStatus(text) {
            const tail = (text || '').slice(-400);
            const re = /\[\[\s*STATUS\s*:\s*(CONTINUAR|CONCLU[IÍ]DO)\s*\]\]/gi;
            let last = null, m;
            while ((m = re.exec(tail)) !== null) last = m[1].toUpperCase();
            if (!last) return null;
            return last === 'CONTINUAR' ? 'continue' : 'done';
        }
    };
}

/** Todos os nós de resposta do assistente, na ordem da página. */
function listAssistantMessages() {
    return getProvider().listAssistantMessages();
}

function findLastAssistantMessage() {
    return getProvider().findLastAssistantMessage();
}

function messageText(node) {
    return getProvider().messageText(node);
}

function hasEndMarker(text) {
    return getProvider().hasEndMarker(text);
}

function readStatus(text) {
    return getProvider().readStatus(text);
}

function cleanPath(raw) {
    return raw.replace(/^[\s`'"*]+|[\s`'"*]+$/g, '').replace(/\\/g, '/');
}

function isPlausiblePath(p) {
    return p.length > 0 && p.length < 260
        && !/[<>|?*"\0]/.test(p)
        && p !== PLACEHOLDER_PATH
        && !/^\.{1,2}$/.test(p)
        && /\w/.test(p);
}

function normalizeContent(text) {
    return text.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '') + '\n';
}

function codeTextOf(pre) {
    const code = pre.querySelector('code');
    return (code || pre).textContent || '';
}

function readFileMarker(node) {
    const firstLine = (node.textContent || '').trim().split('\n')[0];
    const m = FILE_MARKER_RE.exec(firstLine);
    if (!m) return null;
    const p = cleanPath(m[1]);
    return isPlausiblePath(p) ? p : null;
}

function readEditMarker(node) {
    const firstLine = (node.textContent || '').trim().split('\n')[0];
    const m = EDIT_MARKER_RE.exec(firstLine);
    if (!m) return null;
    const p = cleanPath(m[1]);
    return isPlausiblePath(p) ? p : null;
}

function parseEditsFromPre(preContent, filePath) {
    const blocks = [];
    EDIT_BLOCK_RE.lastIndex = 0;
    let m;
    while ((m = EDIT_BLOCK_RE.exec(preContent)) !== null) {
        const search = (m[1] || '').replace(/\r\n/g, '\n');
        const replace = (m[2] || '').replace(/\r\n/g, '\n');
        if (search.length === 0) continue;
        blocks.push({ filePath, isEdit: true, search, replace });
    }
    return blocks;
}

function parseItemsFromContainer(container) {
    const results = [];
    let pendingFilePath = null;
    let pendingEditPath = null;

    for (const node of container.querySelectorAll('h1,h2,h3,h4,h5,h6,p,pre')) {
        if (node.tagName === 'PRE') {
            const raw = codeTextOf(node);
            if (pendingFilePath) {
                results.push({ filePath: pendingFilePath, content: normalizeContent(raw) });
                pendingFilePath = null;
            }
            if (pendingEditPath) {
                const blocks = parseEditsFromPre(raw, pendingEditPath);
                if (blocks.length > 0) {
                    for (const b of blocks) results.push(b);
                } else {
                    results.push({ filePath: pendingEditPath, content: normalizeContent(raw) });
                }
                pendingEditPath = null;
            }
            continue;
        }
        if (node.closest('pre')) continue;

        const fileP = readFileMarker(node);
        if (fileP) { pendingFilePath = fileP; pendingEditPath = null; continue; }

        const editP = readEditMarker(node);
        if (editP) { pendingEditPath = editP; pendingFilePath = null; }
    }
    return results;
}

function parseItemsFromText(text) {
    const results = [];
    const fileRegex = new RegExp(
        '^[ \\t]*(?:#{1,6}[ \\t]*)?(?:\\*\\*)?FILE[ \\t]*:[ \\t]*(.+?)[ \\t]*\\n[ \\t]*' + FENCE + '[\\w+#.-]*\\n([\\s\\S]*?)\\n?[ \\t]*' + FENCE,
        'gim'
    );
    const editRegex = new RegExp(
        '^[ \\t]*(?:#{1,6}[ \\t]*)?(?:\\*\\*)?EDIT[ \\t]*:[ \\t]*(.+?)[ \\t]*\\n[ \\t]*' + FENCE + '[\\w+#.-]*\\n([\\s\\S]*?)\\n?[ \\t]*' + FENCE,
        'gim'
    );
    let m;
    while ((m = fileRegex.exec(text)) !== null) {
        const p = cleanPath(m[1]);
        if (isPlausiblePath(p)) results.push({ filePath: p, content: normalizeContent(m[2]) });
    }
    while ((m = editRegex.exec(text)) !== null) {
        const p = cleanPath(m[1]);
        if (!isPlausiblePath(p)) continue;
        const blocks = parseEditsFromPre(m[2], p);
        for (const b of blocks) results.push(b);
    }
    return results;
}

function findViolations(item) {
    const problems = [];
    const filePath = item.filePath;

    if (item.isEdit) {
        const search = typeof item.search === 'string' ? item.search : '';
        const replace = typeof item.replace === 'string' ? item.replace : '';
        if (search.trim() === '') problems.push('SEARCH vazio');
        if (typeof item.replace !== 'string') problems.push('REPLACE ausente');
        if (ELLIPSIS_LINE_RE.test(search)) problems.push('SEARCH contém uma linha só com "..."');
        if (PLACEHOLDER_LINE_RE.test(search)) problems.push('SEARCH contém placeholder do tipo "resto do código"');
        if (ELLIPSIS_LINE_RE.test(replace)) problems.push('REPLACE contém uma linha só com "..."');
        if (PLACEHOLDER_LINE_RE.test(replace)) problems.push('REPLACE contém placeholder do tipo "resto do código"');
    } else {
        const content = typeof item.content === 'string' ? item.content : '';
        if (content.trim() === '') problems.push('conteúdo vazio');
        if (ELLIPSIS_LINE_RE.test(content)) problems.push('contém uma linha só com "..." (trecho omitido)');
        if (PLACEHOLDER_LINE_RE.test(content)) problems.push('contém placeholder do tipo "resto do código"');
        if (DIFF_MARKER_RE.test(content)) problems.push('parece um diff, não o arquivo completo');
    }

    if (/^[\\/]/.test(filePath) || /^[a-zA-Z]:/.test(filePath) || filePath.split('/').includes('..')) {
        problems.push('caminho fora do projeto');
    }
    return problems;
}

function parseLastResponse() {
    const container = findLastAssistantMessage();
    if (!container) {
        return { error: 'Não encontrei a última resposta na página (o site pode ter mudado; ajuste ASSISTANT_SELECTORS em providers/deepseek.js ou providers/gemini.js).' };
    }

    let found = parseItemsFromContainer(container);
    if (found.length === 0) {
        found = parseItemsFromText(container.innerText || container.textContent || '');
    }
    if (found.length === 0) {
        return { error: 'Nenhum bloco "### FILE:" ou "EDIT:" encontrado na última resposta.' };
    }

    const byPath = new Map();
    const conflicts = new Set();
    for (const f of found) {
        const prev = byPath.get(f.filePath);
        if (prev && !!prev.isEdit !== !!f.isEdit) conflicts.add(f.filePath);
        byPath.set(f.filePath, f);
    }
    const files = [...byPath.values()];

    const problems = [];
    for (const p of conflicts) {
        problems.push(`- ${p}: aparece como FILE: e EDIT: na mesma resposta (use só um).`);
    }
    for (const f of files) {
        for (const v of findViolations(f)) problems.push(`- ${f.filePath}: ${v}`);
    }
    return { files, problems };
}
