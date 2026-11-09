import { Deliverable } from './agentTypes';

function newId(prefix: string): string {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

/**
 * Guarda metadados de entregas por task. Conteúdo dos arquivos vive no
 * applyManager (já aplicado no disco).
 */
export class DeliverableManager {
    private byTask = new Map<string, Deliverable[]>();

    submit(input: {
        taskId: string;
        agentId: string;
        role: Deliverable['role'];
        files: string[];
        summary: string;
        knownIssues?: string[];
        requiresReview?: boolean;
    }): Deliverable {
        const d: Deliverable = {
            deliverableId: newId('del'),
            taskId: input.taskId,
            agentId: input.agentId,
            role: input.role,
            status: 'submitted',
            files: input.files,
            summary: input.summary,
            knownIssues: input.knownIssues ?? [],
            requiresReview: input.requiresReview ?? true,
            createdAt: new Date().toISOString()
        };
        const list = this.byTask.get(input.taskId) ?? [];
        list.push(d);
        this.byTask.set(input.taskId, list);
        return d;
    }

    accept(deliverableId: string): Deliverable | null {
        for (const list of this.byTask.values()) {
            for (const d of list) {
                if (d.deliverableId === deliverableId) {
                    d.status = 'accepted';
                    return d;
                }
            }
        }
        return null;
    }

    reject(deliverableId: string): Deliverable | null {
        for (const list of this.byTask.values()) {
            for (const d of list) {
                if (d.deliverableId === deliverableId) {
                    d.status = 'rejected';
                    return d;
                }
            }
        }
        return null;
    }

    listForTask(taskId: string): Deliverable[] {
        return [...(this.byTask.get(taskId) ?? [])];
    }

    latestForTask(taskId: string): Deliverable | null {
        const list = this.byTask.get(taskId);
        if (!list || list.length === 0) return null;
        return list[list.length - 1];
    }

    all(): Deliverable[] {
        const out: Deliverable[] = [];
        for (const list of this.byTask.values()) out.push(...list);
        return out;
    }
}
