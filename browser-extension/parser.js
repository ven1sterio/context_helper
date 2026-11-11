// Extração dos arquivos (### FILE:) e edições (EDIT:) da última resposta.
// Delega para window.DSProvider (providers/deepseek.js) quando disponível.

const PLACEHOLDER_PATH = 'caminho/do/arquivo.ext';
const FILE_MARKER_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*)?FILE\s*:\s*(.+?)\s*$/i;
const EDIT_MARKER_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*)?EDIT\s*:\s*(.+?)\s*$/i;
const DELETE_MARKER_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*)?DELETE\s*:\s*(.+?)\s*$/i;
const MOVE_MARKER_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:MOVE|RENAME)\s*:\s*(.+?)\s*(?:->|→)\s*(.+?)\s*$/i;
const REPLACE_LINES_MARKER_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*)?REPLACE_LINES\s*:\s*(.+?)\s*$/i;

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
 * Lê "path:start-end" ou "path:start" de uma linha "### REPLACE_LINES:".
 * Retorna { filePath, replaceLines: { start, end } } ou null.
 */
function parseReplaceLinesHeader(raw) {
    const m = REPLACE_LINES_MARKER_RE.exec(raw);
    if (!m) return null;
    return parseReplaceLinesTarget(m[1]);
}

function parseReplaceLinesTarget(raw) {
    const trimmed = String(raw).trim();
    const mm = /^(.+?):(\d+)(?:-(\d+))?$/.exec(trimmed);
    if (!mm) return null;
    const filePath = cleanPath(mm[1]);
    if (!isPlausiblePath(filePath)) return null;
    const start = parseInt(mm[2], 10);
    const end = mm[3] ? parseInt(mm[3], 10) : start;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start < 1 || end < start) return null;
    return { filePath, replaceLines: { start, end } };
}

/**
 * Varre QUALQUER texto (p, h*, pre, texto solto) atrás de `### DELETE: caminho`.
 * Uma linha = uma exclusão. Nunca tem corpo, nunca tem cerca.
 * Retorna uma lista de { filePath, delete: true }, deduplicada por caminho.
 */
function scanDeletes(text) {
    const seen = new Set();
    const out = [];
    const re = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?DELETE[ \t]*:[ \t]*(.+?)[ \t]*$/gim;
    let m;
    while ((m = re.exec(String(text))) !== null) {
        const p = cleanPath(m[1]);
        if (!isPlausiblePath(p) || seen.has(p)) continue;
        seen.add(p);
        out.push({ filePath: p, delete: true });
    }
    return out;
}

/**
 * Varre por `### MOVE: origem -> destino` (ou `RENAME`, `→`, `=>`).
 * Uma linha = um move. `filePath` é o DESTINO, `moveFrom` é a origem.
 * Deduplica por par (origem→destino).
 */
function scanMoves(text) {
    const seen = new Set();
    const out = [];
    const re = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?(?:MOVE|RENAME)[ \t]*:[ \t]*(.+?)[ \t]*(?:->|=>|→)[ \t]*(.+?)[ \t]*$/gim;
    let m;
    while ((m = re.exec(String(text))) !== null) {
        const from = cleanPath(m[1]);
        const to = cleanPath(m[2]);
        if (!isPlausiblePath(from) || !isPlausiblePath(to)) continue;
        if (from === to) continue;
        const key = from + '\u0000' + to;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ filePath: to, moveFrom: from });
    }
    return out;
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
    let pendingReplaceLines = null; // { filePath, replaceLines } do próximo <pre>
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
            if (/^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?(?:FILE|EDIT|REPLACE_LINES|DELETE|MOVE|RENAME)[ \t]*:/im.test(raw)) {
                const inner = parseItemsFromText(raw, warnings);
                for (const p of inner) results.push(p);
                pendingFilePath = null;
                pendingEditPath = null;
                pendingReplaceLines = null;
                lastEditPath = null;
                continue;
            }

            if (pendingReplaceLines) {
                results.push({
                    filePath: pendingReplaceLines.filePath,
                    replaceLines: pendingReplaceLines.replaceLines,
                    content: normalizeContent(raw)
                });
                pendingReplaceLines = null;
                pendingFilePath = null;
                lastEditPath = null;
            } else if (pendingFilePath) {
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

        // REPLACE_LINES antes de FILE (o marcador é mais específico).
        const rlP = parseReplaceLinesHeader(node.textContent || '');
        if (rlP) { pendingReplaceLines = rlP; pendingFilePath = null; pendingEditPath = null; lastEditPath = null; continue; }

        const fileP = readFileMarker(node);
        if (fileP) { pendingFilePath = fileP; pendingEditPath = null; pendingReplaceLines = null; lastEditPath = null; continue; }

        const editP = readEditMarker(node);
        if (editP) { pendingEditPath = editP; pendingFilePath = null; pendingReplaceLines = null; lastEditPath = editP; }
    }
    return results;
}

function parseItemsFromText(text, warnings) {
    const results = [];

    // REPLACE_LINES tem que ser lido ANTES de FILE (o "REPLACE_LINES: a.js:1-2"
    // não seria pego pelo FILE regex, mas assim garantimos a ordem de saída).
    const replaceLinesRegex = new RegExp(
        '^[ \\t]*(?:#{1,6}[ \\t]*)?(?:\\*\\*)?REPLACE_LINES[ \\t]*:[ \\t]*(.+?)[ \\t]*\\n[ \\t]*' + FENCE + '[\\w+#.-]*\\n([\\s\\S]*?)\\n?[ \\t]*' + FENCE,
        'gim'
    );
    let m;
    while ((m = replaceLinesRegex.exec(text)) !== null) {
        const target = parseReplaceLinesTarget(m[1]);
        if (target) {
            results.push({
                filePath: target.filePath,
                replaceLines: target.replaceLines,
                content: normalizeContent(m[2])
            });
        }
    }

    const fileRegex = new RegExp(
        '^[ \\t]*(?:#{1,6}[ \\t]*)?(?:\\*\\*)?FILE[ \\t]*:[ \\t]*(.+?)[ \\t]*\\n[ \\t]*' + FENCE + '[\\w+#.-]*\\n([\\s\\S]*?)\\n?[ \\t]*' + FENCE,
        'gim'
    );
    while ((m = fileRegex.exec(text)) !== null) {
        const p = cleanPath(m[1]);
        if (isPlausiblePath(p)) results.push({ filePath: p, content: normalizeContent(m[2]) });
    }
    // Edições: varredura linha a linha; funciona com ou sem cercas de código.
    for (const b of scanEdits(text, { detectMarkers: true, warnings })) results.push(b);
    // Exclusões: uma linha por arquivo, sem corpo.
    for (const d of scanDeletes(text)) results.push(d);
    // Moves: uma linha "### MOVE: origem -> destino".
    for (const mv of scanMoves(text)) results.push(mv);
    return results;
}

function findViolations(item) {
    const problems = [];
    const filePath = item.filePath;

    if (item.delete) {
        // DELETE é só a linha "### DELETE: caminho" — nada de conteúdo para checar.
        // (Se o modelo escreveu corpo, ele foi ignorado na leitura.)
    } else if (item.moveFrom) {
        // MOVE: só valida os caminhos.
        if (item.moveFrom === item.filePath) {
            problems.push('origem e destino iguais');
        }
    } else if (item.replaceLines) {
        if (typeof item.content !== 'string') {
            problems.push('conteúdo ausente');
        }
        if (!item.replaceLines || !Number.isFinite(item.replaceLines.start) || !Number.isFinite(item.replaceLines.end)) {
            problems.push('range de linhas inválido');
        } else if (item.replaceLines.start < 1 || item.replaceLines.end < item.replaceLines.start) {
            problems.push('range de linhas inválido');
        }
    } else if (item.isEdit) {
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
        const key = (f) => {
            if (f.delete) return 'del\0' + f.filePath;
            if (f.moveFrom) return 'mov\0' + f.moveFrom + '\0' + f.filePath;
            if (f.replaceLines) return 'rl\0' + f.filePath + '\0' + f.replaceLines.start + '-' + f.replaceLines.end;
            if (f.isEdit) return 'edit\0' + f.filePath + '\0' + String(f.search).replace(/\s+/g, ' ').trim() + '\0' + String(f.replace).replace(/\s+/g, ' ').trim();
            return 'file\0' + f.filePath;
        };
        const seen = new Set(found.map(key));
        for (const b of scanEdits(fullText, { detectMarkers: true, warnings: [] })) {
            if (seen.has(key(b))) continue;
            seen.add(key(b));
            b.unfenced = true;
            found.push(b);
        }
        // DELETE que o DOM não viu (ex.: tudo dentro de um único <pre>).
        for (const d of scanDeletes(fullText)) {
            if (seen.has(key(d))) continue;
            seen.add(key(d));
            found.push(d);
        }
        // MOVE que o DOM não viu.
        for (const mv of scanMoves(fullText)) {
            if (seen.has(key(mv))) continue;
            seen.add(key(mv));
            found.push(mv);
        }
    }
    if (found.length === 0 && warnings.length === 0) {
        return { error: 'Nenhum bloco "### FILE:", "EDIT:", "### DELETE:", "### MOVE:" ou "### REPLACE_LINES:" encontrado na última resposta.' };
    }

    // Agrupa por caminho. "kind" distingue FILE / EDIT / DELETE / MOVE / REPLACE_LINES.
    //   - vários EDIT no mesmo arquivo são mantidos (aplicados em ordem);
    //   - para FILE e DELETE, o último vence;
    //   - para MOVE, o destino é a "identidade" (filePath);
    //   - REPLACE_LINES só pode aparecer UMA vez por arquivo (evita deslocamento de linha);
    //   - misturar kinds diferentes no mesmo caminho = conflito.
    const byPath = new Map();
    const conflicts = new Set();
    for (const f of found) {
        const newKind = f.delete ? 'delete'
            : f.moveFrom ? 'move'
            : f.replaceLines ? 'replace_lines'
            : f.isEdit ? 'edit'
            : 'file';
        const cur = byPath.get(f.filePath);
        if (!cur) { byPath.set(f.filePath, { kind: newKind, items: [f] }); continue; }
        if (cur.kind !== newKind) { conflicts.add(f.filePath); continue; }
        if (newKind === 'edit') cur.items.push(f);
        else if (newKind === 'replace_lines') { conflicts.add(f.filePath); continue; }
        else cur.items = [f];
    }
    // MOVE também "toca" a origem — se algum arquivo aparece como origem de
    // um MOVE e como destino de qualquer outra operação, é conflito.
    for (const f of found) {
        if (!f.moveFrom) continue;
        const cur = byPath.get(f.moveFrom);
        if (cur && !(cur.kind === 'move' && cur.items[0] === f)) {
            conflicts.add(f.moveFrom);
        }
    }
    const files = [];
    for (const entry of byPath.values()) for (const it of entry.items) files.push(it);

    const problems = [];
    for (const w of warnings) problems.push(`- ${w}`);
    for (const p of conflicts) {
        problems.push(`- ${p}: aparece com mais de um tipo (FILE:, EDIT:, DELETE: ou MOVE:) na mesma resposta (use só um).`);
    }
    for (const f of files) {
        for (const v of findViolations(f)) problems.push(`- ${f.filePath}: ${v}`);
    }
    return { files, problems };
}
