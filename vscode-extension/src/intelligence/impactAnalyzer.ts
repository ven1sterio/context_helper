import { DependencyAnalyzer } from './dependencyAnalyzer';

export interface ImpactResult {
    changed: string[];
    directlyImpacted: string[];
    transitivelyImpacted: string[];
    total: number;
}

/**
 * Dada uma mudança em N arquivos, identifica o que pode ser afetado:
 *   - quem importa diretamente (impacto direto)
 *   - quem importa esses (impacto transitivo, até `maxDepth`)
 *   - exclui os próprios arquivos alterados
 */
export class ImpactAnalyzer {
    constructor(private deps: DependencyAnalyzer) {}

    analyze(changedFiles: string[], maxDepth = 2): ImpactResult {
        const changedSet = new Set(changedFiles);
        const directly = new Set<string>();
        const transitively = new Set<string>();

        for (const f of changedFiles) {
            for (const d of this.deps.getDependents(f)) {
                if (!changedSet.has(d)) directly.add(d);
            }
        }
        for (const d of directly) {
            for (const t of this.deps.getTransitiveDependents(d, Math.max(1, maxDepth - 1))) {
                if (!changedSet.has(t) && !directly.has(t)) transitively.add(t);
            }
        }

        return {
            changed: [...changedSet],
            directlyImpacted: [...directly],
            transitivelyImpacted: [...transitively],
            total: directly.size + transitively.size
        };
    }
}
