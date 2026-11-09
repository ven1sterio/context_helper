import * as path from 'path';
import { isExcludedPathForWrite } from './pathRules';
import { validatePath } from './security/pathValidator';

export interface ApplyResult {
    status: 'applied' | 'cancelled' | 'error';
    message: string;
    files?: string[];
    /** Edições que não casaram e foram ignoradas (modo parcial). */
    skipped?: string[];
    /** Avisos (correspondência tolerante, edição já aplicada...). */
    warnings?: string[];
}

export interface PlannedFile {
    rel: string;
    abs: string;
    content: string;
}

export type PlanOutcome =
    | { ok: true; files: PlannedFile[]; skipped: string[]; warnings: string[] }
    | { ok: false; error: string };

export interface PlanOptions {
    /**
     * false (padrão): atômico — qualquer SEARCH que não case rejeita o plano inteiro.
     * true: aplica o que casa e devolve o resto em `skipped`.
     */
    partial?: boolean;
    /**
     * Aceita edições que vieram fora de cerca de código (o chat apaga a indentação).
     * Elas são reindentadas por heurística e geram aviso. Padrão: true. O modo
     * automático (sem revisão humana) deve passar false.
     */
    allowUnfenced?: boolean;
}

export const MAX_APPLY_FILES = 20;
export const MAX_APPLY_FILE_CHARS = 500_000;

const fail = (error: string): PlanOutcome => ({ ok: false, error });

interface RawItem {
    filePath?: unknown;
    content?: unknown;
    isEdit?: unknown;
    search?: unknown;
    replace?: unknown;
    unfenced?: unknown;
}

function normalizeEol(text: string): string {
    return text.replace(/\r\n/g, '\n');
}

export function countOccurrences(haystack: string, needle: string): number {
    if (!needle) return 0;
    let count = 0;
    let idx = 0;
    while ((idx = haystack.indexOf(needle, idx)) !== -1) {
        count++;
        idx += needle.length;
    }
    return count;
}

// ---------------------------------------------------------------------------
// Correspondência tolerante (espaços e crases)
// ---------------------------------------------------------------------------

/**
 * Normaliza para comparar: remove crases (o chat costuma "comer" as crases de
 * template strings) e reduz qualquer sequência de espaços/quebras a um espaço.
 * `map[i]` = posição, no texto original, do caractere normalizado `i`.
 */
export function normalizeWithMap(s: string): { norm: string; map: number[] } {
    let norm = '';
    const map: number[] = [];
    let prevSpace = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '`') continue;
        if (/\s/.test(ch)) {
            if (prevSpace) continue;
            prevSpace = true;
            norm += ' ';
            map.push(i);
        } else {
            prevSpace = false;
            norm += ch;
            map.push(i);
        }
    }
    return { norm, map };
}

function normOnly(s: string): string {
    return normalizeWithMap(s).norm;
}


// ---------------------------------------------------------------------------
// Reindentação de trechos que perderam a indentação (edições fora de cerca)
// ---------------------------------------------------------------------------

function detectIndentUnit(content: string): string {
    if (/^\t/m.test(content)) return '\t';
    let min = 0;
    for (const m of content.matchAll(/^( +)\S/gm)) {
        const n = m[1].length;
        if (n > 0 && (min === 0 || n < min)) min = n;
    }
    return ' '.repeat(min > 0 && min <= 4 ? min : 2);
}

function bracketNet(line: string): { net: number; leadingCloser: boolean } {
    const t = line.trim();
    const stripped = t
        .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""')
        .replace(/\/\/.*$/, '');
    let opens = 0, closes = 0;
    for (const ch of stripped) {
        if (ch === '{' || ch === '[' || ch === '(') opens++;
        else if (ch === '}' || ch === ']' || ch === ')') closes++;
    }
    return { net: opens - closes, leadingCloser: /^[}\])]/.test(t) };
}

/** Só reindenta quando NENHUMA linha (a partir da 2ª) tem indentação: sinal de que foi apagada. */
export function looksFlat(text: string): boolean {
    const lines = text.split('\n').slice(1).filter(l => l.trim() !== '');
    return lines.length >= 2 && lines.every(l => !/^\s/.test(l));
}

export function reindentFlat(text: string, baseIndent: string, unit: string): string {
    const lines = text.split('\n');
    let depth = 0;
    return lines.map((ln, i) => {
        const t = ln.trim();
        const { net, leadingCloser } = bracketNet(ln);
        let out: string;
        if (i === 0) out = ln;                       // continua a linha original
        else if (t === '') out = '';
        else out = baseIndent + unit.repeat(Math.max(0, depth - (leadingCloser ? 1 : 0))) + t;
        depth = Math.max(0, depth + Math.sign(net));
        return out;
    }).join('\n');
}

export type EditResult =
    | { ok: true; content: string; relaxed: boolean; note?: string }
    | { ok: false; reason: 'none' | 'ambiguous'; count: number; hint?: string };

function closestLineHint(content: string, search: string): string | undefined {
    const target = search.split('\n').map(l => l.trim()).find(l => l.length >= 6);
    if (!target) return undefined;
    const bigrams = (s: string): Map<string, number> => {
        const m = new Map<string, number>();
        for (let i = 0; i < s.length - 1; i++) {
            const g = s.slice(i, i + 2);
            m.set(g, (m.get(g) ?? 0) + 1);
        }
        return m;
    };
    const tb = bigrams(target);
    const lines = content.split('\n');
    let best = 0;
    let bestIdx = -1;
    lines.forEach((l, i) => {
        const t = l.trim();
        if (t.length < 3) return;
        const lb = bigrams(t);
        let inter = 0;
        for (const [g, c] of tb) inter += Math.min(c, lb.get(g) ?? 0);
        const dice = (2 * inter) / ((target.length - 1) + (t.length - 1));
        if (dice > best) { best = dice; bestIdx = i; }
    });
    if (best < 0.5 || bestIdx < 0) return undefined;
    return `a linha ${bestIdx + 1} é a mais parecida: ${lines[bestIdx].trim().slice(0, 140)}`;
}

/**
 * Aplica UMA edição (SEARCH/REPLACE) sobre `content` (já em LF).
 * 1) casamento exato (exatamente 1 ocorrência);
 * 2) se não achar, casamento tolerante a espaços/indentação/crases: só o TRECHO
 *    QUE MUDA (entre prefixo e sufixo comuns de SEARCH e REPLACE) é substituído
 *    dentro do original, preservando crases e indentação que o modelo perdeu.
 */
export function applyEdit(content: string, searchRaw: string, replaceRaw: string, opts: { reindent?: boolean } = {}): EditResult {
    const search = normalizeEol(searchRaw);
    const replace = normalizeEol(replaceRaw);

    const occ = countOccurrences(content, search);
    if (occ === 1) {
        const idx = content.indexOf(search);
        return { ok: true, content: content.slice(0, idx) + replace + content.slice(idx + search.length), relaxed: false };
    }
    if (occ > 1) return { ok: false, reason: 'ambiguous', count: occ };

    // --- tolerante ---
    const S = search.trim();
    const R = replace.trim();
    const nc = normalizeWithMap(content);
    const full = normOnly(S);
    if (full.length === 0) return { ok: false, reason: 'none', count: 0 };

    let count = 0;
    let first = -1;
    for (let i = nc.norm.indexOf(full); i !== -1; i = nc.norm.indexOf(full, i + full.length)) {
        count++;
        if (first < 0) first = i;
    }
    if (count > 1) return { ok: false, reason: 'ambiguous', count };
    if (count === 0) return { ok: false, reason: 'none', count: 0, hint: closestLineHint(content, search) };

    // prefixo/sufixo comuns entre SEARCH e REPLACE (nunca terminando/começando em espaço)
    let p = 0;
    const maxP = Math.min(S.length, R.length);
    while (p < maxP && S[p] === R[p]) p++;
    while (p > 0 && /\s/.test(S[p - 1])) p--;
    let q = 0;
    const maxQ = Math.min(S.length, R.length) - p;
    while (q < maxQ && S[S.length - 1 - q] === R[R.length - 1 - q]) q++;
    while (q > 0 && /\s/.test(S[S.length - q])) q--;

    const midR = R.slice(p, R.length - q);
    const normStart = normOnly(S.slice(0, p)).length;
    const normEnd = full.length - normOnly(S.slice(S.length - q)).length;
    if (normStart > normEnd) return { ok: false, reason: 'none', count: 0 };

    const lastIdx = first + full.length - 1;
    const origStart = normStart < full.length ? nc.map[first + normStart] : nc.map[lastIdx] + 1;
    const origEnd = q > 0 ? nc.map[first + normEnd] : nc.map[lastIdx] + 1;
    const start = Math.min(origStart, origEnd);

    let insert = midR;
    let reindented = false;
    if (opts.reindent && insert.includes('\n') && looksFlat(insert)) {
        const lineStart = content.lastIndexOf('\n', start - 1) + 1;
        const baseIndent = (/^[ \t]*/.exec(content.slice(lineStart))?.[0]) ?? '';
        insert = reindentFlat(insert, baseIndent, detectIndentUnit(content));
        reindented = true;
    }
    const out = content.slice(0, start) + insert + content.slice(Math.max(origEnd, start));
    const note = reindented
        ? 'o trecho veio sem indentação e foi reindentado automaticamente: confira o diff.'
        : midR.includes('${')
        ? 'REPLACE tem ${...} e o casamento foi tolerante: confira se as crases do template string estão corretas.'
        : undefined;
    return { ok: true, content: out, relaxed: true, note };
}

interface EditState {
    abs: string;
    original: string;
    content: string;      // sempre em LF durante a edição
    hadCRLF: boolean;     // EOL original (para restaurar no resultado)
    applied: number;
    seen: number;
}

/**
 * Valida o que veio do navegador e resolve cada operação em um arquivo final.
 *
 * Aceita dois tipos de item (o navegador envia tudo em `files`):
 *  - `{ filePath, content }` — arquivo completo (criar ou substituir).
 *  - `{ filePath, isEdit: true, search, replace }` — edição pontual.
 *
 * Várias edições no mesmo arquivo são aplicadas em ordem. Por padrão a aplicação
 * é atômica; com `options.partial` as edições que não casam são puladas e listadas
 * em `skipped` (o que casou é aplicado). Edições cujo REPLACE já está no arquivo
 * são tratadas como "já aplicadas" (aviso, não erro).
 *
 * EOL: o original é normalizado para LF para comparar/aplicar e, se tinha CRLF,
 * o resultado volta para CRLF.
 */
export function planFiles(
    input: unknown,
    root: string,
    readFile: (abs: string) => string | undefined,
    options: PlanOptions = {}
): PlanOutcome {
    if (!Array.isArray(input) || input.length === 0) return fail('Nenhuma operação recebida.');
    if (input.length > MAX_APPLY_FILES * 4) return fail(`Operações demais (máximo ${MAX_APPLY_FILES * 4}).`);

    const partial = !!options.partial;
    const allowUnfenced = options.allowUnfenced !== false;
    const byRel = new Map<string, PlannedFile>();
    const editState = new Map<string, EditState>();
    const skipped: string[] = [];
    const warnings: string[] = [];

    for (const raw of input) {
        if (!raw || typeof raw !== 'object') return fail('Formato de operação inválido.');
        const item = raw as RawItem;
        if (typeof item.filePath !== 'string' || !item.filePath.trim()) {
            return fail('Caminho de arquivo ausente.');
        }

        const validated = validatePath(item.filePath, root);
        if (!validated.ok) return fail(validated.error);
        const { rel, abs } = validated;
        if (isExcludedPathForWrite(rel)) return fail(`Caminho protegido (não pode ser alterado pelo chat): ${rel}`);

        if (item.isEdit) {
            if (typeof item.search !== 'string' || typeof item.replace !== 'string') {
                return fail(`EDIT ${rel}: SEARCH/REPLACE ausente.`);
            }
            if (item.search.trim() === '') return fail(`EDIT ${rel}: SEARCH vazio.`);
            if (item.search.length > MAX_APPLY_FILE_CHARS) return fail(`EDIT ${rel}: SEARCH grande demais.`);
            if (item.replace.length > MAX_APPLY_FILE_CHARS) return fail(`EDIT ${rel}: REPLACE grande demais.`);
            if (byRel.has(rel)) {
                return fail(`Conflito: ${rel} aparece como FILE: e EDIT: na mesma resposta.`);
            }

            let state = editState.get(rel);
            if (!state) {
                const original = readFile(abs);
                if (original === undefined) {
                    const msg = `EDIT ${rel}: o arquivo não existe no disco. Use "### FILE:" para criar.`;
                    if (partial) { skipped.push(msg); continue; }
                    return fail(msg);
                }
                const hadCRLF = original.includes('\r\n');
                const lf = normalizeEol(original);
                state = { abs, original: lf, content: lf, hadCRLF, applied: 0, seen: 0 };
                editState.set(rel, state);
            }
            state.seen++;
            const label = `EDIT ${rel} (edição ${state.seen})`;

            const unfenced = item.unfenced === true;
            if (unfenced && !allowUnfenced) {
                const msg = `${label}: veio fora de cerca de código (a indentação se perde no chat). Reenvie o bloco dentro de uma cerca de código.`;
                if (partial) { skipped.push(msg); continue; }
                return fail(msg);
            }

            const res = applyEdit(state.content, item.search, item.replace, { reindent: unfenced });
            if (res.ok) {
                state.content = res.content;
                state.applied++;
                if (unfenced) warnings.push(`${label}: veio fora de cerca de código; a indentação pode ter se perdido no chat.`);
                if (res.relaxed) warnings.push(`${label}: aplicada com correspondência tolerante (espaços/crases).`);
                if (res.note) warnings.push(`${label}: ${res.note}`);
                continue;
            }

            // Edição que já foi aplicada antes (REPLACE já presente no arquivo).
            const rep = normalizeEol(item.replace);
            if (res.reason === 'none' && rep.trim().length >= 6 && countOccurrences(state.content, rep) >= 1) {
                warnings.push(`${label}: já parece aplicada (o REPLACE já está no arquivo); ignorada.`);
                continue;
            }

            const msg = res.reason === 'ambiguous'
                ? `${label}: o SEARCH aparece ${res.count} vezes (ambíguo). Inclua mais contexto no SEARCH ou use "### FILE:".`
                : `${label}: o SEARCH não aparece no arquivo atual.` +
                  (res.hint ? ` Dica: ${res.hint}.` : ' O arquivo pode ter mudado; reenvie o trecho atualizado.');
            if (partial) { skipped.push(msg); continue; }
            return fail(msg);
        } else {
            if (typeof item.content !== 'string') return fail(`Arquivo ${rel}: conteúdo ausente.`);
            if (item.content.length > MAX_APPLY_FILE_CHARS) {
                return fail(`${rel}: arquivo grande demais (máximo ${MAX_APPLY_FILE_CHARS} caracteres).`);
            }
            if (editState.has(rel)) {
                return fail(`Conflito: ${rel} aparece como FILE: e EDIT: na mesma resposta.`);
            }
            byRel.set(rel, { rel, abs, content: item.content });
        }
    }

    // Junta as edições resolvidas, restaurando CRLF se o original era CRLF.
    for (const [rel, s] of editState) {
        if (s.applied === 0 || s.content === s.original) continue;
        const finalContent = s.hadCRLF ? s.content.replace(/\n/g, '\r\n') : s.content;
        byRel.set(rel, { rel, abs: s.abs, content: finalContent });
    }

    if (byRel.size === 0) {
        const why = [...skipped, ...warnings];
        return fail('Nada a aplicar.' + (why.length ? '\n' + why.map(w => `• ${w}`).join('\n') : ''));
    }
    if (byRel.size > MAX_APPLY_FILES) return fail(`Arquivos demais (máximo ${MAX_APPLY_FILES}).`);

    return { ok: true, files: [...byRel.values()], skipped, warnings };
}

export function countLines(text: string): number {
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

export function isSuspiciousShrink(oldLines: number, newLines: number): boolean {
    return oldLines >= 20 && newLines < oldLines * 0.6;
}
