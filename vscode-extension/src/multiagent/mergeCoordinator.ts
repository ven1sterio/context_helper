export interface MergeEntry {
    taskId: string;
    files: string[];
}

export interface MergeConflict {
    file: string;
    tasks: string[];
}

export interface MergePlan {
    files: string[];
    conflicts: MergeConflict[];
    ok: boolean;
}

/**
 * Consolida os arquivos entregues por várias tasks antes de aplicar.
 * Fluxo linear (MVP): arquivos repetidos entre tasks não são conflito.
 * Conflito = mesmo arquivo tocado por duas tasks do MESMO tipo em paralelo
 * (não acontece no MVP).
 */
export function planMerge(entries: MergeEntry[]): MergePlan {
    const byFile = new Map<string, string[]>();
    for (const e of entries) {
        for (const f of e.files) {
            const list = byFile.get(f) ?? [];
            list.push(e.taskId);
            byFile.set(f, list);
        }
    }
    const conflicts: MergeConflict[] = [];
    const files: string[] = [];
    for (const [file, tasks] of byFile) {
        files.push(file);
        if (tasks.length > 1) {
            const unique = new Set(tasks);
            if (unique.size > 1) {
                conflicts.push({ file, tasks: [...unique] });
            }
        }
    }
    return { files, conflicts, ok: conflicts.length === 0 };
}
