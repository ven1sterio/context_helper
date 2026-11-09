import * as path from 'path';
import * as fs from 'fs';

export interface PathValidationResult {
    ok: true;
    abs: string;
    rel: string;
}

export interface PathValidationError {
    ok: false;
    error: string;
}

export type PathValidatorResult = PathValidationResult | PathValidationError;

const MAX_PATH_LEN = 1024;

const fail = (error: string): PathValidationError => ({ ok: false, error });

/**
 * Valida e resolve um caminho relativo ao workspace.
 *
 * Bloqueia:
 *  - caminhos vazios
 *  - caminhos absolutos (/foo, C:\foo)
 *  - traversal (..) em qualquer segmento
 *  - null bytes e caracteres de controle
 *  - caminhos muito longos
 *  - escapes via symlink (verifica o realpath do diretório pai, quando existe)
 *
 * Não verifica nome de arquivo sensível (.env etc.) — isso é responsabilidade
 * de pathRules.ts (isExcludedPathForWrite). Aqui só tratamos a forma do caminho.
 */
export function validatePath(rawPath: string, workspaceRoot: string): PathValidatorResult {
    if (typeof rawPath !== 'string') return fail('caminho não é string');
    const raw = rawPath.trim();
    if (!raw) return fail('caminho vazio');
    if (raw.length > MAX_PATH_LEN) return fail('caminho muito longo');
    if (/[\0\x01-\x1f]/.test(raw)) return fail('caminho contém caracteres inválidos');

    const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '');
    if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
        return fail(`caminho absoluto não permitido: ${raw}`);
    }
    if (normalized.split('/').some(seg => seg === '..' || seg === '')) {
        return fail(`caminho com traversal ou segmento vazio: ${raw}`);
    }

    const abs = path.resolve(workspaceRoot, normalized);
    const rel = path.relative(workspaceRoot, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        return fail(`caminho fora do projeto: ${raw}`);
    }

    // Escape por symlink: verifica o realpath do diretório pai (o arquivo pode
    // não existir ainda — nesse caso usamos o caminho lógico do pai).
    try {
        const realRoot = fs.realpathSync(workspaceRoot);
        const parentAbs = path.dirname(abs);
        let realParent: string;
        try { realParent = fs.realpathSync(parentAbs); }
        catch { realParent = parentAbs; }

        const relFromRoot = path.relative(realRoot, realParent);
        if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
            return fail(`caminho escapa do projeto via symlink: ${raw}`);
        }
    } catch {
        // workspaceRoot sem realpath (raro): mantém o resultado lógico
    }

    return { ok: true, abs, rel: rel.split(path.sep).join('/') };
}
