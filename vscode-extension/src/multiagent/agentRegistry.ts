import { AgentConfig, AgentRole } from './agentTypes';

const DEFAULT_AGENTS: AgentConfig[] = [
    { agentId: 'director-01', role: 'mission_director', label: 'Diretor', provider: 'any', enabled: true },
    { agentId: 'analyst-01', role: 'analyst', label: 'Analista', provider: 'any', enabled: true },
    { agentId: 'planner-01', role: 'planner', label: 'Planejador', provider: 'any', enabled: true },
    { agentId: 'developer-01', role: 'developer', label: 'Dev 1', provider: 'any', enabled: true },
    { agentId: 'reviewer-01', role: 'reviewer', label: 'Revisor', provider: 'any', enabled: true },
    { agentId: 'tester-01', role: 'tester', label: 'Testador', provider: 'any', enabled: true },
    { agentId: 'integrator-01', role: 'integrator', label: 'Integrador', provider: 'any', enabled: true },
    { agentId: 'auditor-01', role: 'final_auditor', label: 'Auditor', provider: 'any', enabled: true }
];

/**
 * Catálogo de agentes lógicos. No MVP todos usam a mesma conexão de
 * navegador — o que muda é o papel no prompt. Multiplas sessões entram
 * depois via sessionRouter.
 */
export class AgentRegistry {
    private agents = new Map<string, AgentConfig>();

    constructor() {
        for (const a of DEFAULT_AGENTS) this.agents.set(a.agentId, { ...a });
    }

    list(): AgentConfig[] { return [...this.agents.values()]; }

    listByRole(role: AgentRole): AgentConfig[] {
        return this.list().filter(a => a.role === role && a.enabled);
    }

    get(agentId: string): AgentConfig | undefined {
        return this.agents.get(agentId);
    }

    firstForRole(role: AgentRole): AgentConfig | null {
        const list = this.listByRole(role);
        return list.length > 0 ? list[0] : null;
    }

    register(cfg: AgentConfig): void {
        this.agents.set(cfg.agentId, { ...cfg });
    }

    disable(agentId: string): void {
        const a = this.agents.get(agentId);
        if (a) a.enabled = false;
    }

    enable(agentId: string): void {
        const a = this.agents.get(agentId);
        if (a) a.enabled = true;
    }

    replaceAll(list: AgentConfig[]): void {
        this.agents.clear();
        for (const a of list) this.agents.set(a.agentId, { ...a });
    }
}
