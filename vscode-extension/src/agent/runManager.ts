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

/** Tentativas por tarefa antes de marcá-la como blocked. */
const MAX_ATTEMPTS_PER_TASK = 3;

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
        if (!mission) throw new Error('Missão não encontrada.');

        // Anota arquivos aplicados na tarefa atual
        if (mission.currentTaskId && it.appliedFiles.length > 0) {
            this.plan.setTaskFiles(mission.currentTaskId, it.appliedFiles);
        }

        // FIX BUG 2: se o modelo concluiu E o build passou, marca a task atual
        // como completed ANTES de evaluate. Sem isso, hasNextTask volta true
        // (a própria task in_progress) e a missão de 1 tarefa levaria 2 iterações.
        const buildOk = it.status === 'applied' && it.runSuccess !== false;
        if (input.modelStatus === 'done' && buildOk && mission.currentTaskId) {
            this.plan.setTaskStatus(mission.currentTaskId, 'completed');
        }

        // Guard: usa attempts atual da task (se ela foi pré-completada acima,
        // currentTaskId é null e o guard só checa falhas/no-progress globais).
        const currentTask = mission.tasks.find(t => t.id === mission.currentTaskId);
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

        // Aplica efeito no plano. `action`/`reason` podem ser reescritos no retry
        // (task bloqueada por excesso de tentativas → avança ou para).
        let action = ev.action;
        let reason = ev.reason;

        switch (action) {
            case 'retry': {
                if (mission.currentTaskId) {
                    // FIX BUG 1: incrementa a tentativa via setTaskStatus('in_progress').
                    // Sem isso, attempts nunca passava de 1 e o limite de retries
                    // (attempts-per-task no guard e MAX_ATTEMPTS_PER_TASK aqui)
                    // nunca disparava.
                    this.plan.setTaskStatus(mission.currentTaskId, 'in_progress');
                    const t = this.plan.current?.tasks.find(x => x.id === mission.currentTaskId);
                    if (t && t.attempts >= MAX_ATTEMPTS_PER_TASK) {
                        this.plan.setTaskStatus(mission.currentTaskId, 'blocked', {
                            failureReason: it.errors[0] ?? reason
                        });
                        const next = this.queue.next();
                        if (next) {
                            this.plan.setTaskStatus(next.id, 'in_progress');
                            action = 'continue';
                            reason = `Tarefa bloqueada após ${t.attempts} tentativas. Retomando com: ${next.title}`;
                        } else {
                            action = 'stop';
                            reason = `Tarefa bloqueada após ${t.attempts} tentativas. Sem mais tarefas.`;
                        }
                    }
                } else {
                    const next = this.queue.next();
                    if (next) {
                        this.plan.setTaskStatus(next.id, 'in_progress');
                        action = 'continue';
                        reason = `Retomando com: ${next.title}`;
                    } else {
                        action = 'stop';
                        reason = 'Sem tarefa ativa para retentar.';
                    }
                }
                break;
            }
            case 'done': {
                // A task normalmente já foi completada no pre-mark acima; este
                // bloco cobre o caso "modelo concluiu sem arquivos" (no-files+done),
                // onde o pre-mark não disparou.
                if (mission.currentTaskId) {
                    const t = mission.tasks.find(x => x.id === mission.currentTaskId);
                    if (t && t.status !== 'completed') {
                        this.plan.setTaskStatus(mission.currentTaskId, 'completed');
                    }
                }
                this.plan.setMissionStatus('completed');
                break;
            }
            case 'stop': {
                if (mission.currentTaskId) {
                    const t = mission.tasks.find(x => x.id === mission.currentTaskId);
                    if (t && t.status !== 'completed') {
                        this.plan.setTaskStatus(mission.currentTaskId, 'failed', { failureReason: reason });
                    }
                }
                this.plan.setMissionStatus('failed');
                break;
            }
            case 'continue': {
                // Se a task atual foi pré-completada, currentTaskId é null —
                // move para a próxima pendente.
                if (!mission.currentTaskId) {
                    const next = this.queue.next();
                    if (next) this.plan.setTaskStatus(next.id, 'in_progress');
                }
                break;
            }
        }

        const finished = action === 'done' || action === 'stop';
        if (finished) {
            this.run.status = action === 'done' ? 'completed' : 'failed';
            this.run.endedAt = new Date().toISOString();
            if (action === 'stop') this.run.lastError = reason;
            await this.history.save(this.run);
            await this.recovery.saveCurrentRun(null);
        } else {
            await this.recovery.saveCurrentRun(this.run);
        }

        await this.plan.flush();

        return { action, reason, run: this.run, mission: this.plan.current };
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