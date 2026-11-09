import {
    Mission, RunRecord, IterationRecord, NextAction,
    DEFAULT_GUARD, IterationGuardLimits
} from './agentTypes';
import { PlanManager, newId } from './planManager';
import { TaskQueue } from './taskQueue';
import { IterationGuard } from './iterationGuard';
import { RunHistory } from './runHistory';
import { RecoveryManager } from './recoveryManager';
import { evaluate, EvaluateInput } from './resultEvaluator';

export interface RecordIterationInput {
    iteration: IterationRecord;
    modelStatus: 'continue' | 'done' | null;
}

export interface AdvanceResult {
    action: NextAction;
    reason: string;
    run: RunRecord;
    mission: Mission | null;
}

/**
 * Orquestra uma execução Full Code 2.0.
 *
 * Fluxo:
 *   start()           → cria mission (1 tarefa) e RunRecord; grava current-run.json
 *   recordIteration() → a cada aplicação, guarda a iteração, checa IterationGuard,
 *                       decide próxima ação (continue/retry/done/stop), atualiza
 *                       o plano e persiste.
 *   cancel()          → marca a run como cancelada, arquiva no history e limpa
 *                       current-run.json
 *   finish()          → idem para conclusão
 *   resumeFrom()      → retoma uma run interrompida a partir de current-run.json
 *
 * A decisão de próxima ação usa:
 *   - IterationGuard: detecta loops e falta de progresso
 *   - resultEvaluator: decide com base no status da iteração + status do modelo
 */
export class RunManager {
    private run: RunRecord | null = null;
    private readonly guard: IterationGuard;

    constructor(
        private plan: PlanManager,
        private queue: TaskQueue,
        private history: RunHistory,
        private recovery: RecoveryManager,
        limits: IterationGuardLimits = DEFAULT_GUARD
    ) {
        this.guard = new IterationGuard(limits);
    }

    get currentRun(): RunRecord | null { return this.run; }

    async start(title: string, objective: string): Promise<RunRecord> {
        const mission = this.plan.create({ title, objective, tasks: [{ title: objective }] });
        this.plan.setMissionStatus('in_progress');
        if (mission.tasks[0]) {
            this.plan.setTaskStatus(mission.tasks[0].id, 'in_progress');
        }

        const run: RunRecord = {
            id: newId('run'),
            missionId: mission.id,
            startedAt: new Date().toISOString(),
            iterations: [],
            status: 'running'
        };
        this.run = run;
        await this.recovery.saveCurrentRun(run);
        await this.plan.flush();
        return run;
    }

    async resumeFrom(recovered: RunRecord): Promise<void> {
        this.run = { ...recovered, status: 'running' };
        await this.recovery.saveCurrentRun(this.run);
    }

    async recordIteration(input: RecordIterationInput): Promise<AdvanceResult> {
        if (!this.run) throw new Error('Nenhuma execução em andamento.');
        const it = input.iteration;
        this.run.iterations.push(it);

        const mission = this.plan.current;

        // Anota os arquivos aplicados na tarefa atual
        if (mission && mission.currentTaskId && it.appliedFiles.length > 0) {
            this.plan.setTaskFiles(mission.currentTaskId, it.appliedFiles);
        }

        const currentTask = mission?.tasks.find(t => t.id === mission.currentTaskId);
        const guardTrip = this.guard.check(
            this.run.iterations,
            currentTask?.attempts ?? 0,
            currentTask?.id ?? null
        );

        const evIn: EvaluateInput = {
            iteration: it,
            modelStatus: input.modelStatus,
            guardTripped: guardTrip.kind !== 'none',
            guardReason: guardTrip.kind === 'none' ? undefined : JSON.stringify(guardTrip),
            missionComplete: this.plan.isMissionComplete(),
            hasNextTask: !!this.queue.next()
        };
        const ev = evaluate(evIn);

        // Aplica efeito no plano
        if (ev.action === 'retry') {
            if (mission && mission.currentTaskId) {
                const t = mission.tasks.find(x => x.id === mission.currentTaskId);
                if (t && t.attempts >= 3) {
                    this.plan.setTaskStatus(mission.currentTaskId, 'blocked', {
                        failureReason: it.errors[0] ?? ev.reason
                    });
                }
            }
        } else if (ev.action === 'done') {
            if (mission && mission.currentTaskId) {
                this.plan.setTaskStatus(mission.currentTaskId, 'completed');
            }
            this.plan.setMissionStatus('completed');
        } else if (ev.action === 'stop') {
            if (mission && mission.currentTaskId) {
                this.plan.setTaskStatus(mission.currentTaskId, 'failed', { failureReason: ev.reason });
            }
            this.plan.setMissionStatus('failed');
        } else if (ev.action === 'continue') {
            if (input.modelStatus === 'done' && mission && mission.currentTaskId) {
                this.plan.setTaskStatus(mission.currentTaskId, 'completed');
                const next = this.queue.next();
                if (next) this.plan.setTaskStatus(next.id, 'in_progress');
            }
        }

        // Atualiza a run
        const finished = ev.action === 'done' || ev.action === 'stop';
        if (finished) {
            this.run.status = ev.action === 'done' ? 'completed' : 'failed';
            this.run.endedAt = new Date().toISOString();
            if (ev.action === 'stop') this.run.lastError = ev.reason;
            await this.history.save(this.run);
            await this.recovery.saveCurrentRun(null);
        } else {
            await this.recovery.saveCurrentRun(this.run);
        }

        await this.plan.flush();

        return { action: ev.action, reason: ev.reason, run: this.run, mission: this.plan.current };
    }

    async cancel(reason: string): Promise<void> {
        if (!this.run) return;
        this.run.status = 'cancelled';
        this.run.endedAt = new Date().toISOString();
        this.run.lastError = reason;
        this.plan.setMissionStatus('cancelled');
        await this.history.save(this.run);
        await this.recovery.saveCurrentRun(null);
        await this.plan.flush();
        this.run = null;
    }

    async finish(): Promise<void> {
        if (!this.run) return;
        if (this.run.status === 'running' || this.run.status === 'paused') {
            this.run.status = 'completed';
            this.run.endedAt = new Date().toISOString();
            await this.history.save(this.run);
            await this.recovery.saveCurrentRun(null);
        }
        this.run = null;
    }
}
