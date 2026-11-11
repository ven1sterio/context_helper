// Extração dos arquivos (### FILE:) e edições (EDIT:) da última resposta.
// Delega para window.DSProvider (providers/deepseek.js) quando disponível.

const PLACEHOLDER_PATH = 'caminho/do/arquivo.ext';
const FILE_MARKER_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*)?FILE\s*:\s*(.+?)\s*$/i;
const EDIT_MARKER_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*)?EDIT\s*:\s*(.+?)\s*$/i;

// Marcadores de bloco SEARCH/REPLACE (tolerantes: 5+ sinais, REPLACE solto no fim, etc.).
const EDIT_START_RE = /^[ \t]*<{5,}[ \t]*(?:SEARCH\b.*)?$/i;
const EDIT_SEP_RE = /^[ \t]*={5,}[ \t]*$/;
const EDIT_END_RE = /^[ \t]*(?:>{5,}[ \t]*(?:REPLACE\b.*)?|REPLACE[ \t]*)$/i;
const FENCE_ONLY_RE = /^[ \t]*(?:`{3,}|~{3,})[\w+#.-]*[ \t]*$/;

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
            const tail = (text || '').slice(-1000);
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

/**
 * Lê blocos SEARCH/REPLACE linha a linha (tolerante a fechamento ausente ou sem
 * ">>>>>>>"). Cada problema encontrado vai para `opts.warnings` (nunca é ignorado
 * em silêncio).
 *  - opts.path: arquivo de destino quando já se sabe (cabeçalho "EDIT:" fora do texto).
 *  - opts.detectMarkers: reconhece "EDIT: caminho" dentro do próprio texto (vários
 *    arquivos num bloco só ou sem cercas de código).
 */
function scanEdits(text, opts) {
    const warnings = (opts && opts.warnings) || [];
    const detect = !!(opts && opts.detectMarkers);
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    const blocks = [];
    let path = (opts && opts.path) || null;
    let n = 0;
    let i = 0;

    const isBoundary = (line) => EDIT_START_RE.test(line)
        || (detect && (EDIT_MARKER_RE.test(line) || FILE_MARKER_RE.test(line) || FENCE_ONLY_RE.test(line)));

    while (i < lines.length) {
        const line = lines[i];
        if (detect && !EDIT_START_RE.test(line)) {
            const em = EDIT_MARKER_RE.exec(line);
            if (em) { const p = cleanPath(em[1]); path = isPlausiblePath(p) ? p : null; i++; continue; }
            if (FILE_MARKER_RE.test(line)) { path = null; i++; continue; }
        }
        if (!EDIT_START_RE.test(line)) { i++; continue; }

        n++; i++;
        const where = path ? ` de ${path}` : '';
        const search = [];
        let sep = false;
        while (i < lines.length) {
            if (EDIT_SEP_RE.test(lines[i])) { sep = true; i++; break; }
            if (isBoundary(lines[i])) break;
            search.push(lines[i]); i++;
        }
        if (!sep) {
            warnings.push(`bloco ${n}${where}: faltou a linha "=======" entre o SEARCH e o REPLACE.`);
            continue;
        }

        const rep = [];
        let closed = false;
        let strict = false; // fechou com ">>>>>>> REPLACE" (linhas em branco antes dele são conteúdo)
        while (i < lines.length) {
            if (EDIT_END_RE.test(lines[i])) { closed = true; strict = /^[ \t]*>/.test(lines[i]); i++; break; }
            if (isBoundary(lines[i])) break;
            rep.push(lines[i]); i++;
        }
        if (!strict) while (rep.length && rep[rep.length - 1].trim() === '') rep.pop();

        if (!path) { warnings.push(`bloco ${n}: não há "EDIT: caminho" antes dele.`); continue; }
        const searchText = search.join('\n');
        if (searchText.trim() === '') { warnings.push(`bloco ${n}${where}: SEARCH vazio.`); continue; }
        blocks.push({ filePath: path, isEdit: true, search: searchText, replace: rep.join('\n') });
    }
    return blocks;
}

function hasEditStart(text) {
    return /^[ \t]*<{5,}/m.test(text);
}

function parseItemsFromContainer(container, warnings) {
    const results = [];
    let pendingFilePath = null;
    let pendingEditPath = null;
    let lastEditPath = null; // vale para os próximos <pre> que só tragam blocos SEARCH/REPLACE

    for (const node of container.querySelectorAll('h1,h2,h3,h4,h5,h6,p,pre')) {
        if (node.tagName === 'PRE') {
            const raw = codeTextOf(node);

            // FIX: alguns chats (ChatGPT com respostas longas, Gemini com
            // markdown strict) às vezes embrulham o próprio "### FILE:" e/ou
            // "EDIT:" DENTRO da mesma cerca de código — o <pre> então começa
            // com "### FILE: path\n```lang\n..." em vez de o marcador estar
            // num <p>/<h*> anterior. Nesse caso o <pre> já contém tudo;
            // delegamos para o parser por texto, que lida bem com esse layout.
            if (/^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?(?:FILE|EDIT)[ \t]*:/im.test(raw)) {
                const inner = parseItemsFromText(raw, warnings);
                for (const p of inner) results.push(p);
                pendingFilePath = null;
                pendingEditPath = null;
                lastEditPath = null;
                continue;
            }

            if (pendingFilePath) {
                results.push({ filePath: pendingFilePath, content: normalizeContent(raw) });
                pendingFilePath = null;
                lastEditPath = null;
            } else if (pendingEditPath || (lastEditPath && hasEditStart(raw))) {
                const target = pendingEditPath || lastEditPath;
                const blocks = scanEdits(raw, { path: target, warnings });
                if (blocks.length > 0) {
                    for (const b of blocks) results.push(b);
                } else if (!hasEditStart(raw)) {
                    // Nunca tratar como arquivo completo: sobrescreveria o arquivo com um trecho qualquer.
                    warnings.push(`${target}: "EDIT:" seguido de código sem blocos SEARCH/REPLACE. Para arquivo inteiro use "### FILE:".`);
                } else {
                    warnings.push(`${target}: há marcadores "<<<<<<<" mas nenhum bloco SEARCH/REPLACE válido (nada foi aplicado deste trecho).`);
                }
                lastEditPath = target;
                pendingEditPath = null;
            } else if (/^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?EDIT[ \t]*:/im.test(raw)) {
                // Vários "EDIT: caminho" dentro de um único bloco de código.
                for (const b of scanEdits(raw, { detectMarkers: true, warnings })) results.push(b);
            }
            continue;
        }
        if (node.closest('pre')) continue;

        // SEARCH/REPLACE solto em parágrafos (sem cerca): quem lê é a varredura de texto,
        // e o EDIT pendente não pode adotar um <pre> posterior que não tem relação.
        if ((pendingEditPath || lastEditPath) && hasEditStart(node.textContent || '')) {
            pendingEditPath = null; lastEditPath = null;
            continue;
        }

        const fileP = readFileMarker(node);
        if (fileP) { pendingFilePath = fileP; pendingEditPath = null; lastEditPath = null; continue; }

        const editP = readEditMarker(node);
        if (editP) { pendingEditPath = editP; pendingFilePath = null; lastEditPath = editP; }
    }
    return results;
}

function parseItemsFromText(text, warnings) {
    const results = [];
    const fileRegex = new RegExp(
        '^[ \\t]*(?:#{1,6}[ \\t]*)?(?:\\*\\*)?FILE[ \\t]*:[ \\t]*(.+?)[ \\t]*\\n[ \\t]*' + FENCE + '[\\w+#.-]*\\n([\\s\\S]*?)\\n?[ \\t]*' + FENCE,
        'gim'
    );
    let m;
    while ((m = fileRegex.exec(text)) !== null) {
        const p = cleanPath(m[1]);
        if (isPlausiblePath(p)) results.push({ filePath: p, content: normalizeContent(m[2]) });
    }
    // Edições: varredura linha a linha; funciona com ou sem cercas de código.
    for (const b of scanEdits(text, { detectMarkers: true, warnings })) results.push(b);
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

    const warnings = [];
    const fullText = container.innerText || container.textContent || '';
    let found = parseItemsFromContainer(container, warnings);
    if (found.length === 0) {
        warnings.length = 0;
        found = parseItemsFromText(fullText, warnings);
        for (const f of found) if (f.isEdit) f.unfenced = true;
    } else {
        // Edições escritas FORA de cerca de código viram parágrafos no chat e o DOM não as vê
        // como <pre>. A varredura de texto as recupera; as já vistas no DOM são ignoradas.
        const key = (f) => f.filePath + '\0' + String(f.search).replace(/\s+/g, ' ').trim() + '\0' + String(f.replace).replace(/\s+/g, ' ').trim();
        const seen = new Set(found.filter(f => f.isEdit).map(key));
        for (const b of scanEdits(fullText, { detectMarkers: true, warnings: [] })) {
            if (seen.has(key(b))) continue;
            seen.add(key(b));
            b.unfenced = true;
            found.push(b);
        }
    }
    if (found.length === 0 && warnings.length === 0) {
        return { error: 'Nenhum bloco "### FILE:" ou "EDIT:" encontrado na última resposta.' };
    }

    // Agrupa por caminho: vários EDIT no mesmo arquivo são TODOS mantidos (em ordem);
    // para FILE, o último vence.
    const byPath = new Map();
    const conflicts = new Set();
    for (const f of found) {
        const cur = byPath.get(f.filePath);
        if (!cur) { byPath.set(f.filePath, { edit: !!f.isEdit, items: [f] }); continue; }
        if (cur.edit !== !!f.isEdit) { conflicts.add(f.filePath); continue; }
        if (f.isEdit) cur.items.push(f); else cur.items = [f];
    }
    const files = [];
    for (const entry of byPath.values()) for (const it of entry.items) files.push(it);

    const problems = [];
    for (const w of warnings) problems.push(`- ${w}`);
    for (const p of conflicts) {
        problems.push(`- ${p}: aparece como FILE: e EDIT: na mesma resposta (use só um).`);
    }
    for (const f of files) {
        for (const v of findViolations(f)) problems.push(`- ${f.filePath}: ${v}`);
    }
    return { files, problems };
}
