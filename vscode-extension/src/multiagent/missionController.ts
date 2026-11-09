import {
    AgentRole, AgentConfig, MissionPlan, MissionStatus,
    TaskContract, TaskPlanItem, AcceptanceCriterion
} from './agentTypes';
import { AgentRegistry } from './agentRegistry';
import { analyzeMission } from './missionAnalyzer';
import { decompose, nextReady, allFinished } from './taskDecomposer';
import { DeliverableManager } from './deliverableManager';
import { ReviewManager } from './reviewManager';
import { computeConsensus } from './consensusManager';
import { planMerge, MergePlan } from './mergeCoordinator';
import { auditMission, AuditResult } from './finalAuditor';
import { SessionRouter } from './sessionRouter';
import { buildRolePrompt } from './rolePrompts';

function newId(prefix: string): string {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

export interface StartMissionInput {
    title: string;
    objective: string;
}

export interface DispatchResult {
    contract: TaskContract;
    agent: AgentConfig;
    prompt: string;
}

export interface DeliverResult {
    accepted: boolean;
    reason: string;
    deliverableId?: string;
    reviewPending?: boolean;
    nextTaskId?: string;
    missionCompleted?: boolean;
    audit?: AuditResult;
}

export type ControllerEvent =
    | { kind: 'mission-started'; mission: MissionPlan }
    | { kind: 'task-dispatched'; mission: MissionPlan; contract: TaskContract }
    | { kind: 'task-accepted'; mission: MissionPlan; taskId: string }
    | { kind: 'task-rejected'; mission: MissionPlan; taskId: string; reason: string }
    | { kind: 'mission-completed'; mission: MissionPlan; audit: AuditResult }
    | { kind: 'mission-failed'; mission: MissionPlan; reason: string };

const MAX_ATTEMPTS_PER_TASK = 3;

export class MissionController {
    private plan: MissionPlan | null = null;
    private buildPassed = false;

    constructor(
        private registry: AgentRegistry,
        private deliverables: DeliverableManager,
        private reviews: ReviewManager,
        private router: SessionRouter,
        private onEvent?: (e: ControllerEvent) => void
    ) {}

    get currentPlan(): MissionPlan | null { return this.plan; }

    start(input: StartMissionInput): MissionPlan {
        // Reset obrigatório: `buildPassed` é acumulativo dentro de uma missão
        // (`this.buildPassed = this.buildPassed || input.buildPassed`), e sem
        // zerar aqui a 2ª missão herdava o "build OK" da 1ª — o auditor final
        // aprovava sem nunca ter rodado build.
        this.buildPassed = false;

        const analysis = analyzeMission(input.objective);
        const tasks = decompose({
            objective: input.objective,
            requirements: analysis.requirements,
            acceptanceCriteria: analysis.acceptanceCriteria,
            suggestedTasks: analysis.suggestedTasks
        });

        const now = new Date().toISOString();
        const plan: MissionPlan = {
            id: newId('mission'),
            title: input.title,
            objective: input.objective,
            requirements: analysis.requirements,
            tasks,
            status: 'analyzing',
            createdAt: now,
            updatedAt: now,
            currentTaskId: null
        };
        this.plan = plan;
        this.emit({ kind: 'mission-started', mission: plan });
        return plan;
    }

    dispatchNext(currentFiles: string): DispatchResult | null {
        if (!this.plan) return null;
        if (allFinished(this.plan.tasks)) return null;

        const task = nextReady(this.plan.tasks);
        if (!task) return null;

        const agent = this.registry.firstForRole(task.role);
        if (!agent) {
            task.status = 'failed';
            task.failureReason = `Nenhum agente disponível para o papel ${task.role}`;
            this.touch();
            this.emit({ kind: 'task-rejected', mission: this.plan, taskId: task.taskId, reason: task.failureReason });
            return null;
        }

        const session = this.router.route(agent);
        if (!session) {
            task.status = 'failed';
            task.failureReason = `Nenhuma sessão de navegador disponível para ${agent.label}`;
            this.touch();
            return null;
        }

        const isRetry = task.status === 'review_rejected';
        task.status = 'dispatched';
        task.attempts += 1;
        
        this.plan.currentTaskId = task.taskId;
        this.plan.status = this.statusFor(task.role);
        this.touch();

        const constraints = [...this.plan.requirements];
        if (isRetry && task.failureReason) {
            constraints.push(`AVISO DA TENTATIVA ANTERIOR: a entrega foi rejeitada. Motivo: ${task.failureReason}. Corrija isso.`);
        }

        const contract: TaskContract = {
            taskId: task.taskId,
            missionId: this.plan.id,
            kind: task.kind,
            role: task.role,
            objective: task.objective,
            context: {
                files: task.role === 'developer' || task.role === 'tester'
                    ? this.filesForRole(task.role)
                    : [],
                constraints,
                previousDeliverables: this.previousDeliverableSummaries(task.taskId)
            },
            acceptanceCriteria: task.acceptanceCriteria,
            outputFormat: (task.role === 'analyst' || task.role === 'planner' ||
                task.role === 'reviewer' || task.role === 'final_auditor') ? 'TEXT_ONLY' : 'FILE_EDIT',
            dependsOn: task.dependsOn,
            maxAttempts: MAX_ATTEMPTS_PER_TASK
        };

        this.emit({ kind: 'task-dispatched', mission: this.plan, contract });
        const prompt = buildRolePrompt(contract, currentFiles);
        return { contract, agent, prompt };
    }

    recordDelivery(input: {
        taskId: string;
        files: string[];
        summary: string;
        knownIssues?: string[];
        buildPassed: boolean;
    }): DeliverResult {
        if (!this.plan) return { accepted: false, reason: 'Missão não iniciada.' };
        const task = this.plan.tasks.find(t => t.taskId === input.taskId);
        if (!task) return { accepted: false, reason: `Task ${input.taskId} não encontrada.` };

        this.buildPassed = this.buildPassed || input.buildPassed;

        const agent = this.registry.firstForRole(task.role);
        const agentId = agent?.agentId ?? 'unknown';

        const requiresReview = task.role === 'developer' || task.role === 'tester';

        const d = this.deliverables.submit({
            taskId: input.taskId,
            agentId,
            role: task.role,
            files: input.files,
            summary: input.summary,
            knownIssues: input.knownIssues,
            requiresReview
        });
        task.deliverableIds.push(d.deliverableId);

        if (task.role === 'analyst' || task.role === 'planner' || task.role === 'integrator') {
            task.status = 'accepted';
            this.deliverables.accept(d.deliverableId);
            this.touch();
            this.emit({ kind: 'task-accepted', mission: this.plan, taskId: task.taskId });
            return this.afterAccept(task);
        }

        if (task.role === 'reviewer') {
            const verdict = /^aprovado/i.test(input.summary.trim()) ? 'approved' as const
                : /^rejeitado/i.test(input.summary.trim()) ? 'rejected' as const
                : null;
            if (!verdict) {
                task.status = 'review_rejected';
                task.failureReason = 'Revisor não respondeu APROVADO/REJEITADO na primeira palavra.';
                this.touch();
                return {
                    accepted: false,
                    reason: task.failureReason,
                    deliverableId: d.deliverableId,
                    reviewPending: true
                };
            }
            
            task.status = 'accepted';
            this.deliverables.accept(d.deliverableId);
            this.touch();

            if (verdict === 'rejected') {
                let firstRejectedId: string | undefined;
                // Volta todas as entregas (dev e tester) para review_rejected
                for (const t of this.plan.tasks) {
                    if (t.status === 'awaiting_review') {
                        if (t.attempts >= MAX_ATTEMPTS_PER_TASK) {
                            t.status = 'failed';
                            t.failureReason = `Rejeitado ${t.attempts} vezes: ${input.summary}`;
                        } else {
                            t.status = 'review_rejected';
                            t.failureReason = input.summary;
                            if (!firstRejectedId) firstRejectedId = t.taskId;
                        }
                    }
                }
                
                // BUGFIX: O revisor precisa voltar para a fila, senão o sistema
                // pula direto para o Integrator quando o Dev e Tester retornarem.
                task.status = 'pending';
                
                this.touch();
                const rejectTaskId = firstRejectedId || this.previousReviewTarget(task.taskId) || task.taskId;
                this.emit({ kind: 'task-rejected', mission: this.plan, taskId: rejectTaskId, reason: input.summary });
                return {
                    accepted: false,
                    reason: input.summary,
                    deliverableId: d.deliverableId,
                    nextTaskId: firstRejectedId
                };
            }

            // Se aprovado, aceita todas as tasks que estavam aguardando review
            for (const t of this.plan.tasks) {
                if (t.status === 'awaiting_review') {
                    t.status = 'accepted';
                    for (const dd of this.deliverables.listForTask(t.taskId)) {
                        this.deliverables.accept(dd.deliverableId);
                    }
                    this.emit({ kind: 'task-accepted', mission: this.plan, taskId: t.taskId });
                }
            }

            this.emit({ kind: 'task-accepted', mission: this.plan, taskId: task.taskId });
            return this.afterAccept(task);
        }

        if (task.role === 'final_auditor') {
            const satisfied = /^cumprido/i.test(input.summary.trim());
            task.status = satisfied ? 'accepted' : 'failed';
            if (!satisfied) task.failureReason = input.summary.slice(0, 300);
            else this.deliverables.accept(d.deliverableId);
            this.touch();
            return this.completeIfDone();
        }

        if (task.role === 'mission_director') {
            task.status = 'accepted';
            this.deliverables.accept(d.deliverableId);
            this.touch();
            return this.afterAccept(task);
        }

        task.status = 'awaiting_review';
        this.touch();
        return {
            accepted: true,
            reason: 'Entrega registrada; aguardando revisão.',
            deliverableId: d.deliverableId,
            reviewPending: true
        };
    }

    complete(): { mission: MissionPlan; audit: AuditResult } {
        if (!this.plan) throw new Error('Nenhuma missão em andamento.');
        const criteria: AcceptanceCriterion[] = [];
        for (const t of this.plan.tasks) {
            for (const c of t.acceptanceCriteria) {
                if (!criteria.find(x => x.id === c.id)) criteria.push(c);
            }
        }
        const audit = auditMission(
            this.plan.tasks,
            this.deliverables.all(),
            this.plan.tasks.flatMap(t => this.reviews.listForTask(t.taskId)),
            criteria,
            this.buildPassed
        );
        this.plan.status = audit.satisfied ? 'completed' : 'failed';
        this.plan.finalVerdict = audit.satisfied ? 'CUMPRIDO' : 'NAO_CUMPRIDO';
        this.touch();
        this.emit(audit.satisfied
            ? { kind: 'mission-completed', mission: this.plan, audit }
            : { kind: 'mission-failed', mission: this.plan, reason: 'Auditoria final falhou' });
        return { mission: this.plan, audit };
    }

    cancel(reason: string): void {
        if (!this.plan) return;
        this.plan.status = 'cancelled';
        this.plan.finalVerdict = reason.slice(0, 200);
        this.touch();
    }

    computeMerge(): MergePlan {
        if (!this.plan) return { files: [], conflicts: [], ok: true };
        return planMerge(this.plan.tasks.map(t => ({
            taskId: t.taskId,
            files: this.deliverables.listForTask(t.taskId).flatMap(d => d.files)
        })));
    }

    private statusFor(role: AgentRole): MissionStatus {
        if (role === 'analyst') return 'analyzing';
        if (role === 'planner') return 'planning';
        if (role === 'reviewer') return 'reviewing';
        if (role === 'integrator') return 'integrating';
        if (role === 'final_auditor') return 'auditing';
        return 'executing';
    }

    private filesForRole(role: AgentRole): string[] {
        if (!this.plan) return [];
        const files = new Set<string>();
        for (const t of this.plan.tasks) {
            if (t.status === 'accepted' || t.status === 'awaiting_review') {
                for (const d of this.deliverables.listForTask(t.taskId)) {
                    for (const f of d.files) files.add(f);
                }
            }
        }
        return [...files];
    }

    private previousDeliverableSummaries(taskId: string): string[] {
        if (!this.plan) return [];
        const out: string[] = [];
        for (const t of this.plan.tasks) {
            if (t.taskId === taskId) break;
            for (const d of this.deliverables.listForTask(t.taskId)) {
                out.push(`[${t.role}] ${d.summary.slice(0, 200)}`);
            }
        }
        return out;
    }

    private previousReviewTarget(reviewTaskId: string): string | null {
        if (!this.plan) return null;
        const idx = this.plan.tasks.findIndex(t => t.taskId === reviewTaskId);
        if (idx <= 0) return null;
        for (let i = idx - 1; i >= 0; i--) {
            const t = this.plan.tasks[i];
            if (t.kind === 'implementation' || t.kind === 'test' || t.kind === 'integration') {
                return t.taskId;
            }
        }
        return null;
    }

    private afterAccept(task: TaskPlanItem): DeliverResult {
        if (!this.plan) return { accepted: true, reason: 'ok' };
        const next = nextReady(this.plan.tasks);
        if (!next && allFinished(this.plan.tasks)) {
            const { audit } = this.complete();
            return {
                accepted: true,
                reason: 'Missão completa.',
                missionCompleted: true,
                audit
            };
        }
        return {
            accepted: true,
            reason: 'Task aceita.',
            nextTaskId: next?.taskId
        };
    }

    private completeIfDone(): DeliverResult {
        if (!this.plan) return { accepted: true, reason: 'ok' };
        if (allFinished(this.plan.tasks)) {
            const { audit } = this.complete();
            return { accepted: true, reason: 'Missão finalizada.', missionCompleted: true, audit };
        }
        return { accepted: true, reason: 'Aguardando próximas tasks.' };
    }

    private touch(): void {
        if (this.plan) this.plan.updatedAt = new Date().toISOString();
    }

    private emit(e: ControllerEvent): void {
        try { this.onEvent?.(e); } catch { /* ignore */ }
    }
}
