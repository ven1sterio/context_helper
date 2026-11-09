import { Task } from './agentTypes';
import { PlanManager } from './planManager';

export interface QueueSnapshot {
    pending: number;
    inProgress: number;
    completed: number;
    failed: number;
    blocked: number;
    currentTaskId: string | null;
}

/**
 * Visão derivada da fila. Não guarda estado próprio — lê do PlanManager a cada
 * chamada. Isso garante que `queue.json` e `plans/*.json` nunca divirjam.
 */
export class TaskQueue {
    constructor(private plan: PlanManager) {}

    snapshot(): QueueSnapshot {
        const m = this.plan.current;
        if (!m) {
            return { pending: 0, inProgress: 0, completed: 0, failed: 0, blocked: 0, currentTaskId: null };
        }
        const s: QueueSnapshot = {
            pending: 0, inProgress: 0, completed: 0, failed: 0, blocked: 0,
            currentTaskId: m.currentTaskId
        };
        for (const t of m.tasks) {
            if (t.status === 'pending') s.pending++;
            else if (t.status === 'in_progress') s.inProgress++;
            else if (t.status === 'completed') s.completed++;
            else if (t.status === 'failed') s.failed++;
            else if (t.status === 'blocked' || t.status === 'review') s.blocked++;
        }
        return s;
    }

    next(): Task | null { return this.plan.nextTask(); }
}
