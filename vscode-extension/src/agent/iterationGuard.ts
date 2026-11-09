import { IterationRecord, IterationGuardLimits, DEFAULT_GUARD } from './agentTypes';

export type GuardTrip =
    | { kind: 'none' }
    | { kind: 'consecutive-failures'; count: number }
    | { kind: 'no-progress'; count: number }
    | { kind: 'attempts-per-task'; taskId: string; attempts: number }
    | { kind: 'total-iterations'; count: number }
    | { kind: 'repeated-error'; error: string; count: number };

/**
 * Detecta loops e falta de progresso em uma sequência de iterações.
 *
 * Critérios (todos independentes):
 *   - maxConsecutiveFailures: últimas N iterações foram apply-failed, parse-error
 *     ou applied-build-failed.
 *   - maxNoProgress: últimas N iterações não aplicaram nenhum arquivo.
 *   - maxAttemptsPerTask: a tarefa atual já acumulou N tentativas.
 *   - maxTotalIterations: limite absoluto.
 *   - repeated-error: a mesma mensagem de erro aparece 3+ vezes seguidas.
 */
export class IterationGuard {
    constructor(private limits: IterationGuardLimits = DEFAULT_GUARD) {}

    check(
        iterations: IterationRecord[],
        currentTaskAttempts: number,
        currentTaskId: string | null
    ): GuardTrip {
        const n = iterations.length;
        if (n >= this.limits.maxTotalIterations) {
            return { kind: 'total-iterations', count: n };
        }

        let failStreak = 0;
        for (let i = iterations.length - 1; i >= 0; i--) {
            const it = iterations[i];
            const failed = it.status === 'apply-failed'
                || it.status === 'parse-error'
                || it.status === 'applied-build-failed';
            if (!failed) break;
            failStreak++;
        }
        if (failStreak >= this.limits.maxConsecutiveFailures) {
            return { kind: 'consecutive-failures', count: failStreak };
        }

        let noProgress = 0;
        for (let i = iterations.length - 1; i >= 0; i--) {
            const it = iterations[i];
            if (it.status === 'no-files' || it.appliedFiles.length === 0) noProgress++;
            else break;
        }
        if (noProgress >= this.limits.maxNoProgress) {
            return { kind: 'no-progress', count: noProgress };
        }

        if (currentTaskId && currentTaskAttempts >= this.limits.maxAttemptsPerTask) {
            return { kind: 'attempts-per-task', taskId: currentTaskId, attempts: currentTaskAttempts };
        }

        const errs = iterations
            .map(i => i.errors.find(e => e.length > 0))
            .filter((e): e is string => !!e);
        if (errs.length >= 3) {
            const last = errs[errs.length - 1];
            let count = 1;
            for (let i = errs.length - 2; i >= 0 && errs[i] === last; i--) count++;
            if (count >= 3) return { kind: 'repeated-error', error: last, count };
        }

        return { kind: 'none' };
    }
}
