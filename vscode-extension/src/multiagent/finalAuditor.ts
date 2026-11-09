import { TaskPlanItem, Deliverable, Review, AcceptanceCriterion } from './agentTypes';

export interface AuditResult {
    satisfied: boolean;
    perCriterion: Array<{
        criterion: AcceptanceCriterion;
        satisfied: boolean;
        evidence: string;
    }>;
    missingTasks: string[];
    rejectedTasks: string[];
}

/**
 * Verifica, a partir dos artefatos (tasks, entregas, reviews), se a missão
 * realmente cumpriu os critérios de aceitação. Não chama o modelo — decide
 * a partir dos fatos.
 */
export function auditMission(
    tasks: TaskPlanItem[],
    deliverables: Deliverable[],
    reviews: Review[],
    criteria: AcceptanceCriterion[],
    buildPassed: boolean
): AuditResult {
    const perCriterion: AuditResult['perCriterion'] = [];
    const missingTasks: string[] = [];
    const rejectedTasks: string[] = [];

    for (const c of criteria) {
        let satisfied = false;
        let evidence = '';
        if (c.check === 'build') {
            satisfied = buildPassed;
            evidence = buildPassed ? 'build passou' : 'build não foi executado ou falhou';
        } else if (c.check === 'review') {
            const approved = reviews.filter(r => r.verdict === 'approved');
            satisfied = approved.length > 0;
            evidence = approved.length > 0 ? `${approved.length} review(s) aprovada(s)` : 'nenhuma review aprovada';
        } else if (c.check === 'audit') {
            const allAccepted = tasks.every(t => t.status === 'accepted');
            satisfied = allAccepted;
            evidence = allAccepted ? 'todas as tasks accepted' : 'há tasks pendentes ou falhas';
        }
        perCriterion.push({ criterion: c, satisfied, evidence });
    }

    for (const t of tasks) {
        if (t.status !== 'accepted') missingTasks.push(t.taskId);
        if (t.status === 'failed') rejectedTasks.push(t.taskId);
    }

    const satisfied = perCriterion.every(p => p.satisfied) && missingTasks.length === 0;
    return { satisfied, perCriterion, missingTasks, rejectedTasks };
}
