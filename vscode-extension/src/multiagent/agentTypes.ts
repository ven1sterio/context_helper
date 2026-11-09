export type AgentRole =
    | 'mission_director'
    | 'analyst'
    | 'planner'
    | 'developer'
    | 'reviewer'
    | 'tester'
    | 'integrator'
    | 'final_auditor';

export const ROLE_LABELS: Record<AgentRole, string> = {
    mission_director: 'Diretor de missão',
    analyst: 'Analista',
    planner: 'Planejador',
    developer: 'Desenvolvedor',
    reviewer: 'Revisor',
    tester: 'Testador',
    integrator: 'Integrador',
    final_auditor: 'Auditor final'
};

export type TaskKind = 'analysis' | 'plan' | 'implementation' | 'review' | 'test' | 'integration' | 'audit';

export type TaskStatus =
    | 'pending'
    | 'dispatched'
    | 'awaiting_deliverable'
    | 'awaiting_review'
    | 'review_rejected'
    | 'accepted'
    | 'failed'
    | 'blocked';

export interface AcceptanceCriterion {
    id: string;
    description: string;
    check: 'build' | 'review' | 'audit';
}

export interface TaskContract {
    taskId: string;
    missionId: string;
    kind: TaskKind;
    role: AgentRole;
    objective: string;
    context: {
        files: string[];
        constraints: string[];
        previousDeliverables?: string[];
    };
    acceptanceCriteria: AcceptanceCriterion[];
    outputFormat: 'FILE_EDIT' | 'TEXT_ONLY';
    dependsOn: string[];
    maxAttempts: number;
}

export interface AgentConfig {
    agentId: string;
    role: AgentRole;
    label: string;
    provider: 'deepseek' | 'gemini' | 'chatgpt' | 'any';
    sessionId?: string;
    enabled: boolean;
}

export type MissionStatus =
    | 'pending'
    | 'analyzing'
    | 'planning'
    | 'executing'
    | 'reviewing'
    | 'integrating'
    | 'auditing'
    | 'completed'
    | 'failed'
    | 'cancelled';

export interface MissionPlan {
    id: string;
    title: string;
    objective: string;
    requirements: string[];
    tasks: TaskPlanItem[];
    status: MissionStatus;
    createdAt: string;
    updatedAt: string;
    currentTaskId: string | null;
    finalVerdict?: string;
}

export interface TaskPlanItem {
    taskId: string;
    kind: TaskKind;
    role: AgentRole;
    title: string;
    objective: string;
    dependsOn: string[];
    status: TaskStatus;
    attempts: number;
    acceptanceCriteria: AcceptanceCriterion[];
    deliverableIds: string[];
    reviewIds: string[];
    failureReason?: string;
}

export interface Deliverable {
    deliverableId: string;
    taskId: string;
    agentId: string;
    role: AgentRole;
    status: 'submitted' | 'accepted' | 'rejected';
    files: string[];
    summary: string;
    knownIssues: string[];
    requiresReview: boolean;
    createdAt: string;
}

export interface Review {
    reviewId: string;
    taskId: string;
    reviewerId: string;
    verdict: 'approved' | 'rejected';
    notes: string;
    createdAt: string;
}

export interface SessionBinding {
    sessionId: string;
    provider: 'deepseek' | 'gemini' | 'chatgpt';
    agentId?: string;
    available: boolean;
    lastPingAt: string;
}
