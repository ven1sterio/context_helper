import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Mission, Task, TaskStatus } from './agentTypes';

const DIR = '.deepseek-sync/agent/plans';
const SAVE_DEBOUNCE_MS = 800;

export function newId(prefix: string): string {
    return prefix + '-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

export interface CreateMissionInput {
    title: string;
    objective: string;
    tasks?: Array<{
        title: string;
        dependsOn?: string[];
        files?: string[];
        acceptanceCriteria?: string[];
    }>;
}

/**
 * Persiste missions em `.deepseek-sync/agent/plans/mission-<id>.json`.
 *
 * Uma mission tem N tarefas; cada tarefa tem dependências. A primeira missão
 * criada pelo Full Code 2.0 tem 1 tarefa (o próprio objetivo). A estrutura
 * suporta N tarefas para quando o planejador (Fase 5) passar a produzir planos
 * estruturados.
 */
export class PlanManager {
    private mission: Mission | null = null;
    private dirty = false;
    private timer: NodeJS.Timeout | null = null;

    constructor(private workspaceRoot: string) {}

    get current(): Mission | null { return this.mission; }

    fileOf(id: string): string {
        return path.join(this.workspaceRoot, DIR, `mission-${id}.json`);
    }

    async load(id: string): Promise<Mission | null> {
        try {
            const raw = await fs.promises.readFile(this.fileOf(id), 'utf8');
            this.mission = JSON.parse(raw) as Mission;
            return this.mission;
        } catch { return null; }
    }

    async list(): Promise<Mission[]> {
        try {
            const dir = path.join(this.workspaceRoot, DIR);
            const names = await fs.promises.readdir(dir);
            const out: Mission[] = [];
            for (const n of names) {
                if (!n.startsWith('mission-') || !n.endsWith('.json')) continue;
                try {
                    const m = JSON.parse(await fs.promises.readFile(path.join(dir, n), 'utf8')) as Mission;
                    out.push(m);
                } catch { /* skip arquivo corrompido */ }
            }
            out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
            return out;
        } catch { return []; }
    }

    create(input: CreateMissionInput): Mission {
        const now = new Date().toISOString();
        const src = input.tasks && input.tasks.length > 0
            ? input.tasks
            : [{ title: input.objective }];
        const tasks: Task[] = src.map((t, i) => ({
            id: `task-${String(i + 1).padStart(3, '0')}`,
            title: t.title,
            status: 'pending',
            dependsOn: t.dependsOn ?? [],
            files: t.files ?? [],
            attempts: 0,
            acceptanceCriteria: t.acceptanceCriteria
        }));
        const mission: Mission = {
            id: newId('mission'),
            title: input.title,
            objective: input.objective,
            status: 'pending',
            createdAt: now,
            updatedAt: now,
            currentTaskId: null,
            tasks
        };
        this.mission = mission;
        this.dirty = true;
        this.scheduleSave();
        return mission;
    }

    setTaskStatus(taskId: string, status: TaskStatus, opts: { failureReason?: string } = {}): void {
        if (!this.mission) return;
        const t = this.mission.tasks.find(x => x.id === taskId);
        if (!t) return;
        t.status = status;
        if (status === 'in_progress') {
            t.attempts += 1;
            this.mission.currentTaskId = taskId;
        } else if (status === 'completed' || status === 'failed' || status === 'cancelled') {
            if (this.mission.currentTaskId === taskId) this.mission.currentTaskId = null;
        }
        if (opts.failureReason) t.failureReason = opts.failureReason;
        this.mission.updatedAt = new Date().toISOString();
        this.dirty = true;
        this.scheduleSave();
    }

    setMissionStatus(status: Mission['status']): void {
        if (!this.mission) return;
        this.mission.status = status;
        this.mission.updatedAt = new Date().toISOString();
        this.dirty = true;
        this.scheduleSave();
    }

    /** Próxima tarefa pronta (todas as dependências completed). */
    nextTask(): Task | null {
        if (!this.mission) return null;
        const done = new Set(this.mission.tasks.filter(t => t.status === 'completed').map(t => t.id));
        for (const t of this.mission.tasks) {
            if (t.status !== 'pending' && t.status !== 'in_progress') continue;
            if (t.dependsOn.every(d => done.has(d))) return t;
        }
        return null;
    }

    isMissionComplete(): boolean {
        if (!this.mission) return false;
        return this.mission.tasks.every(t =>
            t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled'
        );
    }

    setTaskFiles(taskId: string, files: string[]): void {
        if (!this.mission) return;
        const t = this.mission.tasks.find(x => x.id === taskId);
        if (!t) return;
        const set = new Set(t.files);
        for (const f of files) set.add(f);
        t.files = [...set];
        this.dirty = true;
        this.scheduleSave();
    }

    private scheduleSave(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush().catch(() => { /* ignore */ });
        }, SAVE_DEBOUNCE_MS);
    }

    async flush(): Promise<void> {
        if (!this.dirty || !this.mission) return;
        const file = this.fileOf(this.mission.id);
        try { await fs.promises.mkdir(path.dirname(file), { recursive: true }); } catch { /* ignore */ }
        const tmp = file + '.tmp';
        try {
            await fs.promises.writeFile(tmp, JSON.stringify(this.mission, null, 2), 'utf8');
            await fs.promises.rename(tmp, file);
            this.dirty = false;
        } catch {
            try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
        }
    }

    dispose(): void {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (this.dirty && this.mission) {
            try {
                const dir = path.dirname(this.fileOf(this.mission.id));
                fs.mkdirSync(dir, { recursive: true });
                const tmp = this.fileOf(this.mission.id) + '.tmp';
                fs.writeFileSync(tmp, JSON.stringify(this.mission, null, 2), 'utf8');
                fs.renameSync(tmp, this.fileOf(this.mission.id));
            } catch { /* ignore */ }
        }
    }
}
