import { IndexData } from '../indexer';

export interface DependencyInfo {
    file: string;
    dependsOn: string[];
    importedBy: string[];
    depthUp: number;
    depthDown: number;
}

/**
 * Analisa relações entre arquivos a partir do IndexData.
 *
 * O indexer já resolve os imports de cada arquivo (quando possível). Aqui
 * filtramos só os imports que casam com arquivos reais do projeto e construímos
 * o grafo direto + transitivo.
 */
export class DependencyAnalyzer {
    private importedBy = new Map<string, Set<string>>();
    private dependsOn = new Map<string, Set<string>>();

    constructor(private index: IndexData) {
        this.build();
    }

    private build(): void {
        const files = this.index.files;
        for (const [rel, entry] of Object.entries(files)) {
            const deps = new Set<string>();
            for (const imp of entry.imports) {
                if (files[imp]) deps.add(imp);
            }
            this.dependsOn.set(rel, deps);
            for (const dep of deps) {
                let set = this.importedBy.get(dep);
                if (!set) { set = new Set(); this.importedBy.set(dep, set); }
                set.add(rel);
            }
        }
    }

    getDependencies(file: string): string[] {
        return [...(this.dependsOn.get(file) ?? [])];
    }

    getDependents(file: string): string[] {
        return [...(this.importedBy.get(file) ?? [])];
    }

    getTransitiveDependencies(file: string, maxDepth = 2): string[] {
        const out = new Set<string>();
        let frontier = [file];
        for (let d = 0; d < maxDepth && frontier.length > 0; d++) {
            const next: string[] = [];
            for (const f of frontier) {
                for (const dep of this.dependsOn.get(f) ?? []) {
                    if (!out.has(dep) && dep !== file) {
                        out.add(dep);
                        next.push(dep);
                    }
                }
            }
            frontier = next;
        }
        return [...out];
    }

    getTransitiveDependents(file: string, maxDepth = 2): string[] {
        const out = new Set<string>();
        let frontier = [file];
        for (let d = 0; d < maxDepth && frontier.length > 0; d++) {
            const next: string[] = [];
            for (const f of frontier) {
                for (const dep of this.importedBy.get(f) ?? []) {
                    if (!out.has(dep) && dep !== file) {
                        out.add(dep);
                        next.push(dep);
                    }
                }
            }
            frontier = next;
        }
        return [...out];
    }

    fanIn(file: string, maxDepth = 3): number {
        return this.getTransitiveDependents(file, maxDepth).length;
    }

    fanOut(file: string, maxDepth = 3): number {
        return this.getTransitiveDependencies(file, maxDepth).length;
    }

    /** Ciclos no grafo de dependências. Cada ciclo é a lista de arquivos (o último == o primeiro). */
    detectCycles(): string[][] {
        const cycles: string[][] = [];
        const visited = new Set<string>();
        const stack: string[] = [];
        const onStack = new Set<string>();

        const dfs = (node: string) => {
            if (onStack.has(node)) {
                const idx = stack.indexOf(node);
                if (idx >= 0) cycles.push(stack.slice(idx).concat(node));
                return;
            }
            if (visited.has(node)) return;
            visited.add(node);
            stack.push(node);
            onStack.add(node);
            for (const dep of this.dependsOn.get(node) ?? []) dfs(dep);
            stack.pop();
            onStack.delete(node);
        };

        for (const f of Object.keys(this.index.files)) dfs(f);
        return cycles;
    }

    info(file: string): DependencyInfo {
        return {
            file,
            dependsOn: this.getDependencies(file),
            importedBy: this.getDependents(file),
            depthUp: this.fanOut(file, 3),
            depthDown: this.fanIn(file, 3)
        };
    }
}
