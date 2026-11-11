import * as path from 'path';

/**
 * Reescreve os imports de um arquivo dependente quando outro arquivo é movido.
 *
 * Só toca em specs que:
 *   - resolvem para o `movedFrom` (mesma lógica do Indexer: `./`, `../`, `@/`, `~/`
 *     + extensões comuns + `/index`);
 *   - preservam o "estilo" do original (relativo continua relativo, alias continua alias);
 *   - mantêm a extensão quando o original tinha, e removem quando não tinha.
 *
 * Imports "bare" (ex.: `react`, `lodash`) NUNCA são tocados.
 */

const COMMON_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.pyi'];
const EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi)$/i;

interface ImportMatch {
    spec: string;
    start: number;
    end: number;
}

/**
 * Regex de captura de specs de import. Cada regex expõe `m[1]` com o spec.
 * Cobre ESM (`import`/`export from`), CJS (`require`), dinâmico (`import()`)
 * e o "bare import" (`import 'x'`). Não cobre specs em strings
 * multilinha — nesses casos raros o import fica como está.
 */
const SPEC_RES: RegExp[] = [
    /\bfrom\s+['"]([^'"\n]+)['"]/g,
    /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"\n]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /^[ \t]*import\s+['"]([^'"\n]+)['"]/gm
];

function collectSpecs(content: string): ImportMatch[] {
    const out: ImportMatch[] = [];
    for (const re of SPEC_RES) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
            const spec = m[1];
            if (!spec) continue;
            const idx = m[0].indexOf(spec);
            if (idx < 0) continue;
            out.push({ spec, start: m.index + idx, end: m.index + idx + spec.length });
        }
    }
    out.sort((a, b) => a.start - b.start);
    // Remove sobreposições (um require dentro de um from hipotético).
    const filtered: ImportMatch[] = [];
    let lastEnd = -1;
    for (const m of out) {
        if (m.start < lastEnd) continue;
        filtered.push(m);
        lastEnd = m.end;
    }
    return filtered;
}

function stripExt(p: string): string {
    return p.replace(EXT_RE, '');
}

/** Resolve um spec como o Indexer faz: `./`, `../`, `@/`, `~/`. */
export function resolveSpec(
    dependentRel: string,
    spec: string,
    allPaths: ReadonlySet<string>
): string | null {
    const tryExts = (base: string): string | null => {
        if (allPaths.has(base)) return base;
        for (const e of COMMON_EXTS) if (allPaths.has(base + e)) return base + e;
        for (const e of COMMON_EXTS) if (allPaths.has(base + '/index' + e)) return base + '/index' + e;
        return null;
    };

    if (spec.startsWith('.')) {
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(dependentRel), spec));
        if (base.startsWith('..')) return null;
        return tryExts(base);
    }
    if (spec.startsWith('@/') || spec.startsWith('~/')) {
        const sub = spec.slice(2);
        for (const t of [sub, 'src/' + sub]) {
            const hit = tryExts(t);
            if (hit) return hit;
        }
        return null;
    }
    return null;
}

/** Detecta se `@/` (ou `~/`) aponta para a raiz ou para `src/`. */
function aliasBase(
    originalSpec: string,
    movedFrom: string
): 'root' | 'src' | null {
    if (!originalSpec.startsWith('@/') && !originalSpec.startsWith('~/')) return null;
    const oldSub = originalSpec.slice(2);
    const a = stripExt(oldSub);
    const b = stripExt(movedFrom);
    if (b === a) return 'root';
    if (b === 'src/' + a) return 'src';
    return null;
}

function newSpecFor(
    dependentRel: string,
    originalSpec: string,
    movedFrom: string,
    movedTo: string
): string | null {
    const keepExt = EXT_RE.test(originalSpec);
    const target = keepExt ? movedTo : stripExt(movedTo);

    if (originalSpec.startsWith('.')) {
        const fromDir = path.posix.dirname(dependentRel);
        let rel = path.posix.relative(fromDir, target);
        if (!rel.startsWith('.')) rel = './' + rel;
        return rel;
    }

    if (originalSpec.startsWith('@/') || originalSpec.startsWith('~/')) {
        const prefix = originalSpec.slice(0, 2);
        const base = aliasBase(originalSpec, movedFrom);
        if (base === 'src' && target.startsWith('src/')) {
            return prefix + target.slice(4);
        }
        return prefix + target;
    }

    return null;
}

/**
 * Retorna o novo conteúdo (ou null se nada mudou).
 * `changes` é o nº de imports reescritos — útil pra aviso no painel.
 */
export function rewriteImportSpecs(
    content: string,
    dependentRel: string,
    movedFrom: string,
    movedTo: string,
    allPaths: ReadonlySet<string>
): { content: string; changes: number } | null {
    if (!content) return null;
    const matches = collectSpecs(content);
    if (matches.length === 0) return null;

    let out = '';
    let cursor = 0;
    let changes = 0;
    for (const m of matches) {
        const resolved = resolveSpec(dependentRel, m.spec, allPaths);
        if (resolved !== movedFrom) continue;
        const replacement = newSpecFor(dependentRel, m.spec, movedFrom, movedTo);
        if (!replacement || replacement === m.spec) continue;
        out += content.slice(cursor, m.start) + replacement;
        cursor = m.end;
        changes++;
    }
    if (changes === 0) return null;
    out += content.slice(cursor);
    return { content: out, changes };
}
