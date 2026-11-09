import { AgentConfig, AgentRole, TaskPlanItem } from './agentTypes';
import { AgentRegistry } from './agentRegistry';
import { SessionRouter } from './sessionRouter';

export interface DispatchTarget {
    task: TaskPlanItem;
    agent: AgentConfig;
    sessionId: string;
}

/**
 * Seleciona agente + sessão para uma task. Reaproveita registry e router.
 */
export class TaskDispatcher {
    constructor(
        private registry: AgentRegistry,
        private router: SessionRouter
    ) {}

    findTarget(task: TaskPlanItem): DispatchTarget | null {
        const candidates = this.registry.listByRole(task.role as AgentRole);
        for (const agent of candidates) {
            const session = this.router.route(agent);
            if (session) {
                return { task, agent, sessionId: session.sessionId };
            }
        }
        return null;
    }

    listAvailability(): Array<{ role: AgentRole; available: number; total: number }> {
        const roles: AgentRole[] = [
            'mission_director', 'analyst', 'planner', 'developer',
            'reviewer', 'tester', 'integrator', 'final_auditor'
        ];
        const out: Array<{ role: AgentRole; available: number; total: number }> = [];
        for (const role of roles) {
            const agents = this.registry.listByRole(role);
            let available = 0;
            for (const a of agents) if (this.router.route(a)) available++;
            out.push({ role, available, total: agents.length });
        }
        return out;
    }
}
