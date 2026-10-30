import * as path from 'path';
import { isExcludedPathForWrite } from './pathRules';

export interface ApplyResult {
    status: 'applied' | 'cancelled' | 'error';
    message: string;
    files?: string[];
}

export interface PlannedFile {
    rel: string;
    abs: string;
    content: string;
}

export type PlanOutcome =
    | { ok: true; files: PlannedFile[] }
    | { ok: false; error: string };

export const MAX_APPLY_FILES = 20;
export const MAX_APPLY_FILE_CHARS = 500_000;

const fail = (error: string): PlanOutcome => ({ ok: false, error });

interface RawItem {
    filePath?: unknown;
    content?: unknown;
    isEdit?: unknown;
    search?: unknown;
    replace?: unknown;
}

function normalizeEol(text: string): string {
    return text.replace(/\r\n/g, '\n');
}

function countOccurrences(haystack: string, needle: string): number {
    if (!needle) return 0;
    let count = 0;
    let idx = 0;
    while ((idx = haystack.indexOf(needle, idx)) !== -1) {
        count++;
        idx += needle.length;
    }
    return count;
}

interface EditState {
    abs: string;
    content: string;      // sempre em LF durante a edição
    hadCRLF: boolean;     // EOL original (para restaurar no resultado)
}

/**
 * Valida o que veio do navegador e resolve cada operação em um arquivo final.
 *
 * Aceita dois tipos de item (o navegador envia tudo em `files`):
 *  - `{ filePath, content }` — arquivo completo (criar ou substituir).
 *  - `{ filePath, isEdit: true, search, replace }` — edição pontual.
 *
 * Para edições, `readFile(abs)` é usado para ler o conteúdo atual em disco. A
 * SEARCH precisa casar EXATAMENTE 1 vez; caso contrário o plano inteiro é
 * rejeitado (aplicação atômica: nada é gravado se algo estiver errado).
 * Várias edições no mesmo arquivo são aplicadas em ordem.
 *
 * EOL: o original é lido e normalizado para LF para comparar/aplicar. Ao final,
 * se o original tinha CRLF, o resultado é convertido de volta para CRLF — assim
 * editar um arquivo Windows não muda silenciosamente a quebra de linha.
 */
export function planFiles(
    input: unknown,
    root: string,
    readFile: (abs: string) => string | undefined
): PlanOutcome {
    if (!Array.isArray(input) || input.length === 0) return fail('Nenhuma operação recebida.');
    if (input.length > MAX_APPLY_FILES) return fail(`Operações demais (máximo ${MAX_APPLY_FILES}).`);

    const byRel = new Map<string, PlannedFile>();
    const editState = new Map<string, EditState>();

    for (const raw of input) {
        if (!raw || typeof raw !== 'object') return fail('Formato de operação inválido.');
        const item = raw as RawItem;
        if (typeof item.filePath !== 'string' || !item.filePath.trim()) {
            return fail('Caminho de arquivo ausente.');
        }

        const rawPath = item.filePath.trim().replace(/\\/g, '/').replace(/^\.\//, '');
        if (!rawPath || rawPath.includes('\0') || rawPath.endsWith('/')) return fail(`Caminho inválido: "${item.filePath}"`);
        if (rawPath.startsWith('/') || /^[a-zA-Z]:/.test(rawPath)) return fail(`Caminho absoluto não permitido: ${rawPath}`);
        if (rawPath.split('/').some(seg => seg === '..')) return fail(`Caminho fora do projeto: ${rawPath}`);

        const abs = path.resolve(root, rawPath);
        const check = path.relative(root, abs);
        if (!check || check.startsWith('..') || path.isAbsolute(check)) return fail(`Caminho fora do projeto: ${rawPath}`);

        const rel = check.split(path.sep).join('/');
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
                    return fail(`EDIT ${rel}: o arquivo não existe no disco. Use "### FILE:" para criar.`);
                }
                const hadCRLF = original.includes('\r\n');
                state = { abs, content: normalizeEol(original), hadCRLF };
                editState.set(rel, state);
            }

            const search = normalizeEol(item.search);
            const replace = normalizeEol(item.replace);
            const occ = countOccurrences(state.content, search);
            if (occ === 0) {
                return fail(
                    `EDIT ${rel}: o SEARCH não aparece no arquivo atual. ` +
                    'O arquivo pode ter mudado; peça ao modelo para reenviar o trecho atualizado.'
                );
            }
            if (occ > 1) {
                return fail(
                    `EDIT ${rel}: o SEARCH aparece ${occ} vezes (ambíguo). ` +
                    'Peça ao modelo para incluir mais contexto no SEARCH ou usar "### FILE:".'
                );
            }
            const idx = state.content.indexOf(search);
            state.content = state.content.slice(0, idx) + replace + state.content.slice(idx + search.length);
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

    // Junta as edições resolvidas na lista final, restaurando CRLF se o original era CRLF.
    for (const [rel, s] of editState) {
        const finalContent = s.hadCRLF ? s.content.replace(/\n/g, '\r\n') : s.content;
        byRel.set(rel, { rel, abs: s.abs, content: finalContent });
    }

    return { ok: true, files: [...byRel.values()] };
}

export function countLines(text: string): number {
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

export function isSuspiciousShrink(oldLines: number, newLines: number): boolean {
    return oldLines >= 20 && newLines < oldLines * 0.6;
}
