export type TaskStatus =
    | 'pending'
    | 'in_progress'
    | 'blocked'
    | 'review'
    | 'completed'
    | 'failed'
    | 'cancelled';

export type MissionStatus =
    | 'pending'
    | 'in_progress'
    | 'paused'
    | 'completed'
    | 'failed'
    | 'cancelled';

export type RunStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export type IterationStatus =
    | 'applied'
    | 'applied-build-failed'
    | 'apply-failed'
    | 'no-files'
    | 'parse-error'
    | 'cancelled';

export type NextAction = 'continue' | 'retry' | 'done' | 'stop';

export interface Task {
    id: string;
    title: string;
    status: TaskStatus;
    dependsOn: string[];
    files: string[];
    attempts: number;
    acceptanceCriteria?: string[];
    failureReason?: string;
}

export interface Mission {
    id: string;
    title: string;
    objective: string;
    status: MissionStatus;
    createdAt: string;
    updatedAt: string;
    currentTaskId: string | null;
    tasks: Task[];
}

export interface IterationRecord {
    index: number;
    startedAt: string;
    endedAt?: string;
    appliedFiles: string[];
    runSuccess?: boolean;
    runCommand?: string;
    runExitCode?: number | null;
    runOutputTail?: string;
    errors: string[];
    status: IterationStatus;
    modelStatus?: 'continue' | 'done' | null;
}

export interface RunRecord {
    id: string;
    missionId: string;
    startedAt: string;
    endedAt?: string;
    iterations: IterationRecord[];
    status: RunStatus;
    lastError?: string;
}

export interface IterationGuardLimits {
    /** Falhas consecutivas (apply falhou OU build falhou) antes de desistir. */
    maxConsecutiveFailures: number;
    /** Iterações seguidas sem nenhum arquivo aplicado. */
    maxNoProgress: number;
    /** Tentativas por tarefa antes de bloquear. */
    maxAttemptsPerTask: number;
    /** Limite absoluto de iterações por run. */
    maxTotalIterations: number;
}

export const DEFAULT_GUARD: IterationGuardLimits = {
    maxConsecutiveFailures: 6,
    maxNoProgress: 3,
    maxAttemptsPerTask: 5,
    maxTotalIterations: 40
};
