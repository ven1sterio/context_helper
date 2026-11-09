import { IndexData } from '../indexer';
import { tokenize, expandTokens, ScoredFile } from '../selector';

/**
 * Busca local por significado (sem API paga).
 *
 * Combina:
 *   - tokens do pedido com expansão de sinônimos/conceitos (reusa selector)
 *   - match em nome de arquivo/pasta/símbolo/export
 *   - TF-ish no conteúdo (log2 de ocorrências + nº de tokens distintos)
 *   - pastas de conceito (ex.: "tela" → pages/, components/)
 *
 * Não é ML. Um modelo local (Ollama) pode substituir o miolo depois — só o
 * formato de retorno precisa ser mantido.
 */
export interface SemanticResult {
    files: ScoredFile[];
    tokens: string[];
}

export function semanticSearch(
    query: string,
    index: IndexData,
    contents: ReadonlyMap<string, string>,
    maxFiles = 40
): SemanticResult {
    const base = tokenize(query);
    if (base.length === 0) return { files: [], tokens: [] };
    const { tokens, dirs, broad } = expandTokens(base);
    const tokenSet = new Set(tokens);

    const scores = new Map<string, ScoredFile>();
    const bump = (path: string, pts: number, reason: string) => {
        const cur = scores.get(path);
        if (cur) {
            cur.score += pts;
            if (cur.reasons.length < 6 && !cur.reasons.includes(reason)) cur.reasons.push(reason);
        } else {
            scores.set(path, { path, score: pts, reasons: [reason] });
        }
    };

    for (const [rel, entry] of Object.entries(index.files)) {
        const lowerRel = rel.toLowerCase();
        const baseName = (rel.split('/').pop() ?? '').toLowerCase();
        const dir = lowerRel.slice(0, lowerRel.length - baseName.length);

        for (const t of tokens) {
            if (t.length < 3) continue;
            if (baseName.includes(t)) bump(rel, 5, `nome:${t}`);
            else if (dir.includes(t)) bump(rel, 3, `pasta:${t}`);
            else if (entry.symbols.some(s => s.name.toLowerCase().includes(t))) bump(rel, 4, `símbolo:${t}`);
            else if (entry.exports.some(e => e.toLowerCase().includes(t))) bump(rel, 3, `export:${t}`);
        }

        for (const d of dirs) {
            if (lowerRel.startsWith(d) || lowerRel.includes('/' + d)) {
                bump(rel, broad ? 6 : 3, `conceito:${d}`);
                break;
            }
        }

        const content = contents.get(rel);
        if (content) {
            const lower = content.toLowerCase();
            let hits = 0;
            let distinct = 0;
            for (const t of tokenSet) {
                if (t.length < 3) continue;
                const n = countOccurrences(lower, t, 5);
                if (n > 0) { hits += n; distinct++; }
            }
            if (hits > 0) {
                const norm = Math.log2(hits + 1) + distinct * 0.5;
                bump(rel, Math.min(8, norm), `conteúdo(${distinct})`);
            }
        }
    }

    const ranked = [...scores.values()].sort((a, b) => b.score - a.score);
    return { files: ranked.slice(0, maxFiles), tokens };
}

function countOccurrences(hay: string, needle: string, cap = 10): number {
    let n = 0, i = 0;
    while (n < cap && (i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
    return n;
}
