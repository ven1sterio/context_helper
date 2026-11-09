import * as fs from 'fs';
import * as path from 'path';

export interface GraphNode {
    id: string;
    label: string;
    file: string | null;
    community: string | null;
}

export interface GraphEdge {
    to: string;
    relation: string;
    weight: number;
}

export interface GraphData {
    nodes: Map<string, GraphNode>;
    adj: Map<string, GraphEdge[]>;
    byFile: Map<string, string[]>;
    communities: Map<string, string[]>;
    mtimeMs: number;
    unmapped: number;
}

const RELATION_WEIGHT: Array<[RegExp, number]> = [
    [/call|invoke|import|inherit|extend|implement|use|depend|contain|define/i, 1],
    [/rationale|doc|cite|mention|reference|relat|similar|semantic/i, 0.5]
];

function relationWeight(rel: string): number {
    for (const [re, w] of RELATION_WEIGHT) if (re.test(rel)) return w;
    return 0.6;
}

function confidenceWeight(c: unknown): number {
    if (typeof c === 'number' && isFinite(c)) return Math.max(0.1, Math.min(1, c));
    if (typeof c === 'string') {
        const u = c.toUpperCase();
        if (u.startsWith('EXTRACT')) return 1;
        if (u.startsWith('INFER')) return 0.6;
        if (u.startsWith('AMBIG')) return 0.3;
    }
    return 0.8;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const endId = (v: any): string => str(v && typeof v === 'object' ? v.id : v);

export function normalizeFile(raw: string, root: string, known: ReadonlySet<string>): string | null {
    if (!raw) return null;
    let p = raw.replace(/\\/g, '/');
    const rootN = root.replace(/\\/g, '/').replace(/\/$/, '');
    if (p.toLowerCase().startsWith(rootN.toLowerCase() + '/')) p = p.slice(rootN.length + 1);
    p = p.replace(/^\.\//, '');
    p = p.replace(/(?:#L?\d+(?:-\d+)?|:\d+(?::\d+)?)$/, '');
    if (known.has(p)) return p;
    const tail = '/' + p;
    let hit: string | null = null;
    for (const k of known) {
        if (k === p || k.endsWith(tail) || p.endsWith('/' + k)) {
            if (hit && hit !== k) return null;
            hit = k;
        }
    }
    return hit;
}

export function parseGraph(raw: any, root: string, known: ReadonlySet<string>, mtimeMs = 0): GraphData {
    const nodes = new Map<string, GraphNode>();
    const adj = new Map<string, GraphEdge[]>();
    const byFile = new Map<string, string[]>();
    const communities = new Map<string, string[]>();
    let unmapped = 0;

    const rawNodes: any[] = Array.isArray(raw?.nodes) ? raw.nodes : [];
    for (const n of rawNodes) {
        const id = str(n?.id);
        if (!id) continue;
        const fileRaw = str(n.source_file ?? n.file ?? n.path ?? n.filepath ?? n.source ?? n.source_location);
        const file = normalizeFile(fileRaw, root, known);
        if (fileRaw && !file) unmapped++;
        const comm = n.community ?? n.group ?? n.cluster;
        const node: GraphNode = {
            id,
            label: str(n.label ?? n.name ?? n.title) || id,
            file,
            community: comm === undefined || comm === null ? null : String(comm)
        };
        nodes.set(id, node);
        if (file) {
            const list = byFile.get(file) || [];
            list.push(id);
            byFile.set(file, list);
            if (node.community !== null) {
                const cl = communities.get(node.community) || [];
                if (!cl.includes(file)) cl.push(file);
                communities.set(node.community, cl);
            }
        }
    }

    const rawEdges: any[] = Array.isArray(raw?.links) ? raw.links : (Array.isArray(raw?.edges) ? raw.edges : []);
    for (const e of rawEdges) {
        const a = endId(e?.source ?? e?.from);
        const b = endId(e?.target ?? e?.to);
        if (!a || !b || !nodes.has(a) || !nodes.has(b)) continue;
        const relation = str(e.relation ?? e.type ?? e.label ?? e.kind);
        const weight = relationWeight(relation) * confidenceWeight(e.confidence ?? e.confidence_score);
        for (const [x, y] of [[a, b], [b, a]]) {
            const list = adj.get(x) || [];
            list.push({ to: y, relation, weight });
            adj.set(x, list);
        }
    }
    return { nodes, adj, byFile, communities, mtimeMs, unmapped };
}

export class GraphStore {
    private data: GraphData | null = null;
    private graphFile: string;

    constructor(private workspaceRoot: string, relGraphPath = 'graphify-out/graph.json') {
        this.graphFile = path.isAbsolute(relGraphPath) ? relGraphPath : path.join(workspaceRoot, relGraphPath);
    }

    setPath(relGraphPath: string) {
        this.graphFile = path.isAbsolute(relGraphPath) ? relGraphPath : path.join(this.workspaceRoot, relGraphPath);
        this.data = null;
    }

    get path(): string { return this.graphFile; }

    load(known: ReadonlySet<string>): boolean {
        try {
            const st = fs.statSync(this.graphFile);
            if (this.data && this.data.mtimeMs === st.mtimeMs) return true;
            const raw = JSON.parse(fs.readFileSync(this.graphFile, 'utf8'));
            this.data = parseGraph(raw, this.workspaceRoot, known, st.mtimeMs);
            return this.data.byFile.size > 0;
        } catch {
            this.data = null;
            return false;
        }
    }

    get(): GraphData | null { return this.data; }

    readReport(maxChars = 6000): string {
        try {
            const p = path.join(path.dirname(this.graphFile), 'GRAPH_REPORT.md');
            const t = fs.readFileSync(p, 'utf8');
            return t.length > maxChars ? t.slice(0, maxChars) + '\n[...relatório cortado]' : t;
        } catch { return ''; }
    }

    /** Há arquivos do projeto mais novos que o grafo? */
    staleCount(files: Iterable<string>, limit = 200): number {
        if (!this.data) return 0;
        let n = 0;
        for (const rel of files) {
            try {
                if (fs.statSync(path.join(this.workspaceRoot, rel)).mtimeMs > this.data.mtimeMs + 1000) n++;
            } catch { /* ignore */ }
            if (n >= limit) break;
        }
        return n;
    }

    /** Lista (limitada) dos arquivos mais novos que o grafo. */
    getStaleFiles(files: Iterable<string>, limit = 200): string[] {
        if (!this.data) return [];
        const out: string[] = [];
        for (const rel of files) {
            try {
                if (fs.statSync(path.join(this.workspaceRoot, rel)).mtimeMs > this.data.mtimeMs + 1000) {
                    out.push(rel);
                    if (out.length >= limit) break;
                }
            } catch { /* ignore */ }
        }
        return out;
    }
}
