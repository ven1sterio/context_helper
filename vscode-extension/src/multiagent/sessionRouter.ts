import { SessionBinding, AgentConfig } from './agentTypes';

/**
 * Mapeia sessões de navegador para agentes lógicos.
 * MVP: uma única sessão disponível ("default").
 */
export class SessionRouter {
    private sessions = new Map<string, SessionBinding>();

    register(sessionId: string, provider: SessionBinding['provider']): void {
        this.sessions.set(sessionId, {
            sessionId,
            provider,
            available: true,
            lastPingAt: new Date().toISOString()
        });
    }

    unregister(sessionId: string): void {
        this.sessions.delete(sessionId);
    }

    markAvailable(sessionId: string, available: boolean): void {
        const s = this.sessions.get(sessionId);
        if (s) {
            s.available = available;
            s.lastPingAt = new Date().toISOString();
        }
    }

    list(): SessionBinding[] {
        return [...this.sessions.values()];
    }

    route(agent: AgentConfig): SessionBinding | null {
        if (agent.sessionId) {
            const s = this.sessions.get(agent.sessionId);
            if (s && s.available) return s;
        }
        for (const s of this.sessions.values()) {
            if (s.available) return s;
        }
        return null;
    }

    bind(agentId: string, sessionId: string): void {
        const s = this.sessions.get(sessionId);
        if (s) s.agentId = agentId;
    }
}
