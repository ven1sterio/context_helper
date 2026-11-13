// Extração dos arquivos (### FILE:) e edições (EDIT:) da última resposta.
// Delega para window.DSProvider (providers/deepseek.js) quando disponível.

const PLACEHOLDER_PATH = 'caminho/do/arquivo.ext';
const FILE_MARKER_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*)?FILE\s*:\s*(.+?)\s*$/i;
const EDIT_MARKER_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*)?EDIT\s*:\s*(.+?)\s*$/i;
const DELETE_MARKER_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*)?DELETE\s*:\s*(.+?)\s*$/i;
const MOVE_MARKER_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:MOVE|RENAME)\s*:\s*(.+?)\s*(?:->|→)\s*(.+?)\s*$/i;
const REPLACE_LINES_MARKER_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*)?REPLACE_LINES\s*:\s*(.+?)\s*$/i;

// Marcadores de bloco SEARCH/REPLACE (tolerantes: 5+ sinais, REPLACE solto no fim, etc.).
// Formato novo (imune ao markdown): [[SEARCH]] ... [[REPLACE]] ... [[END]].
// Motivo: a linha "=======" fora de cerca vira título (setext) no chat e SOME do texto lido.
const EDIT_START_RE = /^[ \t]*(?:<{5,}[ \t]*(?:SEARCH\b.*)?|\[\[[ \t]*SEARCH[ \t]*\]\])[ \t]*$/i;
const EDIT_SEP_RE = /^[ \t]*(?:={5,}|\[\[[ \t]*REPLACE[ \t]*\]\])[ \t]*$/i;
const EDIT_END_RE = /^[ \t]*(?:>{5,}[ \t]*(?:REPLACE\b.*)?|REPLACE[ \t]*|\[\[[ \t]*(?:END|\/REPLACE)[ \t]*\]\])$/i;
const EDIT_START_ANY_RE = /^[ \t]*(?:<{5,}|\[\[[ \t]*SEARCH[ \t]*\]\])/im;
const FENCE_ONLY_RE = /^[ \t]*(?:`{3,}|~{3,})[\w+#.-]*[ \t]*$/;

const ELLIPSIS_LINE_RE = /^\s*(?:(?:\/\/|#|\/\*+|<!--|--|;)\s*)?(?:\.{3}|…)\s*(?:\*+\/|-->)?\s*$/m;
const PLACEHOLDER_LINE_RE = /^\s*(?:\/\/|#|\/\*+|<!--|<|--)\s*(?:\.{3}|…)?\s*(?:resto do c[oó]digo|restante do c[oó]digo|rest of (?:the )?(?:code|file|function|class)|remaining code|existing code|unchanged code|c[oó]digo (?:existente|anterior|original|omitido|inalterado))/im;
const DIFF_MARKER_RE = /^(?:@@ .+ @@|\+\+\+ [ab]\/|--- [ab]\/)/m;

function getProvider() {
    if (window.DSProvider) return window.DSProvider;
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

function scanEdits(text, opts) {
    const warnings = (opts && opts.warnings) || [];
    const detect = !!(opts && opts.detectMarkers);
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    const blocks = [];
    let path = (opts && opts.path) || null;
    let lastKnownPath = path;
    let n = 0;
    let i = 0;

    const isBoundary = (line) => EDIT_START_RE.test(line)
        || (detect && (EDIT_MARKER_RE.test(line) || FILE_MARKER_RE.test(line) || FENCE_ONLY_RE.test(line)));

    while (i < lines.length) {
        const line = lines[i];
        if (detect && !EDIT_START_RE.test(line)) {
            const em = EDIT_MARKER_RE.exec(line);
            if (em) { const p = cleanPath(em[1]); path = isPlausiblePath(p) ? p : null; lastKnownPath = path; i++; continue; }
            const fm = FILE_MARKER_RE.exec(line);
            if (fm) {
                const p = cleanPath(fm[1]);
                if (isPlausiblePath(p)) lastKnownPath = p;
                path = null;
                i++;
                continue;
            }
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
            warnings.push(`bloco ${n}${where}: faltou o separador entre o SEARCH e o REPLACE ("[[REPLACE]]" ou "======="). Se o texto veio fora de cerca de código, o chat apaga a linha "======="; peça o bloco dentro da cerca, no formato [[SEARCH]]/[[REPLACE]]/[[END]].`);
            continue;
        }

        const rep = [];
        let closed = false;
        let strict = false;
        while (i < lines.length) {
            if (EDIT_END_RE.test(lines[i])) { closed = true; strict = /^[ \t]*>/.test(lines[i]); i++; break; }
            if (isBoundary(lines[i])) break;
            rep.push(lines[i]); i++;
        }
        if (!strict) while (rep.length && rep[rep.length - 1].trim() === '') rep.pop();

        if (!path) {
            if (lastKnownPath) {
                path = lastKnownPath;
            } else {
                warnings.push(`bloco ${n}: não há "EDIT: caminho" antes dele.`);
                continue;
            }
        }
        const searchText = search.join('\n');
        if (searchText.trim() === '') { warnings.push(`bloco ${n}${where}: SEARCH vazio.`); continue; }
        blocks.push({ filePath: path, isEdit: true, search: searchText, replace: rep.join('\n') });
    }
    return blocks;
}

function hasEditStart(text) {
    return EDIT_START_ANY_RE.test(text);
}

function parseItemsFromContainer(container, warnings) {
    const results = [];
    let pendingFilePath = null;
    let pendingEditPath = null;
    let pendingReplaceLines = null;
    let lastEditPath = null;

    for (const node of container.querySelectorAll('h1,h2,h3,h4,h5,h6,p,pre')) {
        if (node.tagName === 'PRE') {
            const raw = codeTextOf(node);

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
                if (EDIT_START_RE.test(raw.split('\n').find(l => l.trim() !== '') || '') || hasEditStart(raw)) {
                    const blocks = scanEdits(raw, { path: pendingFilePath, warnings });
                    for (const b of blocks) results.push(b);
                } else {
                    results.push({ filePath: pendingFilePath, content: normalizeContent(raw) });
                }
                pendingFilePath = null;
                lastEditPath = null;
            } else if (pendingEditPath || (lastEditPath && hasEditStart(raw))) {
                const target = pendingEditPath || lastEditPath;
                const blocks = scanEdits(raw, { path: target, warnings });
                if (blocks.length > 0) {
                    for (const b of blocks) results.push(b);
                } else if (!hasEditStart(raw)) {
                    warnings.push(`${target}: "EDIT:" seguido de código sem blocos SEARCH/REPLACE. Para arquivo inteiro use "### FILE:".`);
                } else {
                    warnings.push(`${target}: há marcadores "<<<<<<<" mas nenhum bloco SEARCH/REPLACE válido (nada foi aplicado deste trecho).`);
                }
                lastEditPath = target;
                pendingEditPath = null;
            } else if (/^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?EDIT[ \t]*:/im.test(raw)) {
                for (const b of scanEdits(raw, { detectMarkers: true, warnings })) results.push(b);
            }
            continue;
        }
        if (node.closest('pre')) continue;

        if ((pendingEditPath || lastEditPath) && hasEditStart(node.textContent || '')) {
            pendingEditPath = null; lastEditPath = null;
            continue;
        }

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
        if (hasEditStart(m[2])) continue;
        if (isPlausiblePath(p)) results.push({ filePath: p, content: normalizeContent(m[2]) });
    }
    for (const b of scanEdits(text, { detectMarkers: true, warnings })) results.push(b);
    for (const d of scanDeletes(text)) results.push(d);
    for (const mv of scanMoves(text)) results.push(mv);
    return results;
}

function findViolations(item) {
    const problems = [];
    const filePath = item.filePath;

    if (item.delete) {
    } else if (item.moveFrom) {
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
        const site = (typeof window !== 'undefined' && window.DSProviderName) || 'o site';
        return { error: `Não encontrei a última resposta na página do ${site} (o site pode ter mudado; ajuste ASSISTANT_SELECTORS em providers/*.js).` };
    }

    const warnings = [];
    const fullText = container.innerText || container.textContent || '';
    let found = parseItemsFromContainer(container, warnings);
    if (found.length === 0) {
        warnings.length = 0;
        found = parseItemsFromText(fullText, warnings);
        for (const f of found) if (f.isEdit) f.unfenced = true;
    } else {
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
        for (const d of scanDeletes(fullText)) {
            if (seen.has(key(d))) continue;
            seen.add(key(d));
            found.push(d);
        }
        for (const mv of scanMoves(fullText)) {
            if (seen.has(key(mv))) continue;
            seen.add(key(mv));
            found.push(mv);
        }
    }
    if (found.length === 0 && warnings.length === 0) {
        const peek = fullText.replace(/\s+/g, ' ').trim();
        return { error: 'Nenhum bloco "### FILE:", "EDIT:", "### DELETE:", "### MOVE:" ou "### REPLACE_LINES:" encontrado na última resposta '
            + `(li ${fullText.length} caracteres; começa com: "${peek.slice(0, 80)}"; termina com: "${peek.slice(-60)}"). `
            + 'Se isso não parece a resposta do modelo, o seletor da página pegou o nó errado (raciocínio/bloco antigo).' };
    }

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

const RE_MAX_REQUESTS = 8;
const RE_OPS = new Set(['info', 'functions', 'decompile', 'disasm', 'xrefs', 'strings', 'asm', 'patch']);

function tokenizeReArgs(s) {
    const re = /(?:[^\s"']+=)?"[^"]*"|(?:[^\s"']+=)?'[^']*'|\S+/g;
    const unq = (v) => v.replace(/^(["'])([\s\S]*)\1$/, '$2');
    const args = [];
    const opts = {};
    let m;
    while ((m = re.exec(String(s))) !== null) {
        const km = /^([A-Za-z_]+)=([\s\S]*)$/.exec(m[0]);
        if (km) opts[km[1].toLowerCase()] = unq(km[2]);
        else args.push(unq(m[0]));
    }
    return { args, opts };
}

function validateReRequest(r) {
    const o = r.opts;
    switch (r.op) {
        case 'info': case 'functions': return null;
        case 'decompile': case 'disasm': case 'xrefs':
            return r.args.length ? null : 'faltou o alvo (nome da função ou endereço 0x...)';
        case 'strings':
            return r.args.length ? null : 'faltou o texto a procurar';
        case 'asm':
            return (o.addr && (o.text || r.args.length)) ? null : 'use addr=0x... text="instrução"';
        case 'patch':
            if (!(o.rva || o.addr || o.offset)) return 'faltou rva=, addr= ou offset=';
            if (!o.expect || !o.write) return 'faltam expect="bytes originais" e write="bytes novos"';
            return null;
    }
    return 'operação desconhecida';
}

function scanReRequests(text) {
    const requests = [];
    const errors = [];
    const seen = new Set();
    const re = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?RE[ \t]*:[ \t]*(.+?)[ \t]*$/gim;
    let m;
    while ((m = re.exec(String(text))) !== null) {
        const body = m[1].replace(/\*+$/, '').trim();
        const sp = body.split(/\s+/);
        const op = (sp[0] || '').toLowerCase();
        if (!RE_OPS.has(op)) continue;
        const { args, opts } = tokenizeReArgs(body.slice(sp[0].length));
        const file = args.shift();
        if (!file || !isPlausiblePath(cleanPath(file))) { errors.push(`RE: ${body} → faltou o arquivo`); continue; }
        const req = { op, file: cleanPath(file), args, opts };
        const bad = validateReRequest(req);
        if (bad) { errors.push(`RE: ${body} → ${bad}`); continue; }
        const key = JSON.stringify(req);
        if (seen.has(key)) continue;
        seen.add(key);
        if (requests.length >= RE_MAX_REQUESTS) { errors.push(`máximo de ${RE_MAX_REQUESTS} pedidos RE por resposta; ignorado: ${body}`); continue; }
        requests.push(req);
    }
    return { requests, errors };
}
