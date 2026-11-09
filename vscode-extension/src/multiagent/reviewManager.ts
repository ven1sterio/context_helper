import { Review, Deliverable } from './agentTypes';

function newId(prefix: string): string {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

/**
 * Guarda revisões por task. Uma task pode ter múltiplos revisores (para
 * consensusManager).
 */
export class ReviewManager {
    private byTask = new Map<string, Review[]>();

    submit(input: {
        taskId: string;
        reviewerId: string;
        verdict: 'approved' | 'rejected';
        notes: string;
    }): Review {
        const r: Review = {
            reviewId: newId('rev'),
            taskId: input.taskId,
            reviewerId: input.reviewerId,
            verdict: input.verdict,
            notes: input.notes,
            createdAt: new Date().toISOString()
        };
        const list = this.byTask.get(input.taskId) ?? [];
        list.push(r);
        this.byTask.set(input.taskId, list);
        return r;
    }

    listForTask(taskId: string): Review[] {
        return [...(this.byTask.get(taskId) ?? [])];
    }

    consolidate(taskId: string): { status: 'pending' | 'approved' | 'rejected'; notes: string[] } {
        const list = this.listForTask(taskId);
        if (list.length === 0) return { status: 'pending', notes: [] };
        const rejections = list.filter(r => r.verdict === 'rejected');
        if (rejections.length > 0) {
            return {
                status: 'rejected',
                notes: rejections.map(r => `[${r.reviewerId}] ${r.notes}`)
            };
        }
        return {
            status: 'approved',
            notes: list.map(r => `[${r.reviewerId}] ${r.notes}`)
        };
    }

    needsReview(deliverable: Deliverable | null): boolean {
        if (!deliverable) return false;
        if (!deliverable.requiresReview) return false;
        return this.listForTask(deliverable.taskId).length === 0;
    }
}
