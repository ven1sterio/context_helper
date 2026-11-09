import * as fs from 'fs';
import * as path from 'path';
import { RunRecord } from './agentTypes';

const DIR = '.deepseek-sync/agent/history';
const KEEP = 50;

export interface RunHistoryItem {
    id: string;
    missionId: string;
    startedAt: string;
    status: string;
    iterations: number;
}

/**
 * Guarda cada RunRecord concluída em `.deepseek-sync/agent/history/run-<id>.json`.
 * Mantém as 50 mais recentes.
 */
export class RunHistory {
    constructor(private workspaceRoot: string) {}

    async save(run: RunRecord): Promise<void> {
        const dir = path.join(this.workspaceRoot, DIR);
        try { await fs.promises.mkdir(dir, { recursive: true }); } catch { /* ignore */ }
        const file = path.join(dir, `run-${run.id}.json`);
        const tmp = file + '.tmp';
        try {
            await fs.promises.writeFile(tmp, JSON.stringify(run, null, 2), 'utf8');
            await fs.promises.rename(tmp, file);
            await this.rotate(dir);
        } catch { /* ignore */ }
    }

    async list(): Promise<RunHistoryItem[]> {
        try {
            const dir = path.join(this.workspaceRoot, DIR);
            const names = (await fs.promises.readdir(dir))
                .filter(n => n.startsWith('run-') && n.endsWith('.json'));
            const out: RunHistoryItem[] = [];
            for (const n of names) {
                try {
                    const r = JSON.parse(await fs.promises.readFile(path.join(dir, n), 'utf8')) as RunRecord;
                    out.push({
                        id: r.id,
                        missionId: r.missionId,
                        startedAt: r.startedAt,
                        status: r.status,
                        iterations: r.iterations.length
                    });
                } catch { /* skip */ }
            }
            out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
            return out;
        } catch { return []; }
    }

    async load(id: string): Promise<RunRecord | null> {
        try {
            const file = path.join(this.workspaceRoot, DIR, `run-${id}.json`);
            return JSON.parse(await fs.promises.readFile(file, 'utf8')) as RunRecord;
        } catch { return null; }
    }

    private async rotate(dir: string): Promise<void> {
        try {
            const files = (await fs.promises.readdir(dir))
                .filter(n => n.startsWith('run-') && n.endsWith('.json'))
                .map(n => {
                    let mtime = 0;
                    try { mtime = fs.statSync(path.join(dir, n)).mtimeMs; } catch { /* ignore */ }
                    return { n, mtime };
                })
                .sort((a, b) => b.mtime - a.mtime);
            for (const x of files.slice(KEEP)) {
                try { await fs.promises.unlink(path.join(dir, x.n)); } catch { /* ignore */ }
            }
        } catch { /* ignore */ }
    }
}
