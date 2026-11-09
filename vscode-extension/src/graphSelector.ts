import { GraphData } from './graphStore';
import { ScoredFile, tokenize, expandTokens } from './selector';

export interface GraphSelectOptions {
    maxFiles?: number;
    hops?: number;            // profundidade da expansão (padrão 2)
    graphWeight?: number;     // peso do grafo na mistura (padrão 1)
    localWeight?: number;     // peso da busca local (padrão 0.6)
    /** Bônus para arquivos que (transitivamente) importam os top selecionados. */
    impactBonus?: number;
    /** Callback: dado um arquivo, devolve quem o importa (vem do Indexer). */
    dependentsOf?: (rel: string) => string[];
}

export interface GraphSelection {
    files: ScoredFile[];
    seeds: string[];          // arquivos que casaram direto com o pedido
    usedGraph: boolean;
}

/** Pontua os rótulos de nós contra os termos do pedido. */
function seedScore(label: string, tokens: string[]): number {
    const l = label.toLowerCase();
    let s = 0;
    for (const t of tokens) {
        if (t.length < 3) continue;
        if (l === t) s += 6;
        else if (l.includes(t)) s += 3;
    }
    return s;
}

/**
 * Seleção guiada pelo grafo: acha nós cujo rótulo casa com o pedido, expande pelos
 * vizinhos (decaindo por salto e pelo peso da aresta) e mistura com a busca local.
 * O grafo só decide QUAIS arquivos entram — o código vem do VS Code.
 */
export function selectWithGraph(
    query: string,
    graph: GraphData,
    local: ScoredFile[],
    opts: GraphSelectOptions = {}
): GraphSelection {
    const maxFiles = opts.maxFiles ?? 40;
    const hops = opts.hops ?? 2;
    const gW = opts.graphWeight ?? 1;
    const lW = opts.localWeight ?? 0.6;

    const { tokens } = expandTokens(tokenize(query));
    const fileScore = new Map<string, { score: number; reasons: string[] }>();
    const bump = (file: string | null, pts: number, why: string) => {
        if (!file || pts <= 0) return;
        const cur = fileScore.get(file) || { score: 0, reasons: [] };
        cur.score += pts;
        if (cur.reasons.length < 4 && !cur.reasons.includes(why)) cur.reasons.push(why);
        fileScore.set(file, cur);
    };

    // 1) sementes
    const seedNodes: Array<{ id: string; score: number }> = [];
    for (const n of graph.nodes.values()) {
        if (!n.file) continue;
        const s = seedScore(n.label, tokens);
        if (s > 0) seedNodes.push({ id: n.id, score: s });
    }
    seedNodes.sort((a, b) => b.score - a.score);
    const topSeeds = seedNodes.slice(0, 25);

    const seedFiles = new Set<string>();
    for (const s of topSeeds) {
        const n = graph.nodes.get(s.id)!;
        seedFiles.add(n.file!);
        bump(n.file, s.score, `grafo: ${n.label}`);
    }

    // 2) expansão por saltos
    for (const s of topSeeds) {
        let frontier: Array<{ id: string; w: number }> = [{ id: s.id, w: s.score * 0.4 }];
        const seen = new Set<string>([s.id]);
        for (let hop = 1; hop <= hops; hop++) {
            const next: Array<{ id: string; w: number }> = [];
            for (const f of frontier) {
                for (const e of graph.adj.get(f.id) || []) {
                    if (seen.has(e.to)) continue;
                    seen.add(e.to);
                    const w = f.w * e.weight * 0.5;
                    if (w < 0.15) continue;
                    const nb = graph.nodes.get(e.to);
                    bump(nb?.file ?? null, w, `grafo: ${e.relation || 'liga'} ${graph.nodes.get(s.id)!.label}`);
                    next.push({ id: e.to, w });
                }
            }
            frontier = next.slice(0, 200);
        }
    }

    // 3) bônus de comunidade para as 3 melhores sementes
    const commBonus = new Set<string>();
    for (const s of topSeeds.slice(0, 3)) {
        const c = graph.nodes.get(s.id)?.community;
        if (c !== null && c !== undefined) commBonus.add(c);
    }
    for (const c of commBonus) {
        for (const file of graph.communities.get(c) || []) bump(file, 1, `comunidade ${c}`);
    }

    // 4) mistura com a busca local
    const merged = new Map<string, ScoredFile>();
    for (const [path, v] of fileScore) merged.set(path, { path, score: v.score * gW, reasons: v.reasons });
    for (const l of local) {
        const cur = merged.get(l.path);
        if (cur) {
            cur.score += l.score * lW;
            for (const r of l.reasons) if (cur.reasons.length < 5 && !cur.reasons.includes(r)) cur.reasons.push(r);
        } else {
            merged.set(l.path, { path: l.path, score: l.score * lW, reasons: l.reasons });
        }
    }

    // 5a) bônus de impacto: top arquivos "puxam" quem os importa
    if (opts.impactBonus && opts.impactBonus > 0 && opts.dependentsOf) {
        const topPaths = [...merged.values()]
            .sort((a, b) => b.score - a.score)
            .slice(0, 5)
            .map(f => f.path);
        const seen = new Set<string>();
        for (const p of topPaths) {
            for (const dep of opts.dependentsOf(p)) {
                if (seen.has(dep)) continue;
                seen.add(dep);
                const cur = merged.get(dep);
                if (cur) {
                    cur.score += opts.impactBonus;
                    if (cur.reasons.length < 5 && !cur.reasons.includes(`importa ${p}`)) {
                        cur.reasons.push(`importa ${p}`);
                    }
                }
            }
        }
    }

    // 5b) sementes sempre entram; resto por score
    const ranked = [...merged.values()].sort((a, b) => b.score - a.score);
    const out: ScoredFile[] = [];
    const taken = new Set<string>();
    for (const r of ranked) if (seedFiles.has(r.path)) { out.push(r); taken.add(r.path); }
    for (const r of ranked) {
        if (out.length >= maxFiles) break;
        if (!taken.has(r.path)) { out.push(r); taken.add(r.path); }
    }
    out.sort((a, b) => b.score - a.score);
    return { files: out.slice(0, Math.max(maxFiles, seedFiles.size)), seeds: [...seedFiles], usedGraph: topSeeds.length > 0 };
}
