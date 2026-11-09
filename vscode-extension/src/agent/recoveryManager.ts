import * as fs from 'fs';
import * as path from 'path';
import { RunRecord, Mission } from './agentTypes';

const FILE = '.deepseek-sync/agent/current-run.json';

export type RecoveryStatus =
    | { kind: 'none' }
    | { kind: 'running'; run: RunRecord; mission: Mission | null }
    | { kind: 'stale'; run: RunRecord; reason: string };

/**
 * `current-run.json` existe enquanto uma execução está em andamento. Quando
 * a run termina (done/stop/cancel), é apagado — e o resumo vai para history/.
 *
 * Ao abrir o VS Code, inspect() detecta se sobrou uma run interrompida e se
 * ela ainda pode ser retomada com segurança:
 *   - arquivos aplicados na última iteração ainda existem no disco?
 *   - mission plan ainda está disponível?
 * Se sim → { kind: 'running' }. Se não → { kind: 'stale' }.
 */
export class RecoveryManager {
    constructor(private workspaceRoot: string) {}

    fileOf(): string {
        return path.join(this.workspaceRoot, FILE);
    }

    async saveCurrentRun(run: RunRecord | null): Promise<void> {
        const file = this.fileOf();
        try { await fs.promises.mkdir(path.dirname(file), { recursive: true }); } catch { /* ignore */ }
        if (run === null) {
            try { await fs.promises.unlink(file); } catch { /* ignore */ }
            return;
        }
        const tmp = file + '.tmp';
        try {
            await fs.promises.writeFile(tmp, JSON.stringify(run, null, 2), 'utf8');
            await fs.promises.rename(tmp, file);
        } catch { /* ignore */ }
    }

    async loadCurrentRun(): Promise<RunRecord | null> {
        try {
            const raw = await fs.promises.readFile(this.fileOf(), 'utf8');
            return JSON.parse(raw) as RunRecord;
        } catch { return null; }
    }

    async inspect(): Promise<RecoveryStatus> {
        const run = await this.loadCurrentRun();
        if (!run) return { kind: 'none' };
        if (run.status !== 'running' && run.status !== 'paused') return { kind: 'none' };

        // Tenta carregar a mission
        let mission: Mission | null = null;
        try {
            const mPath = path.join(
                this.workspaceRoot,
                '.deepseek-sync/agent/plans',
                `mission-${run.missionId}.json`
            );
            mission = JSON.parse(await fs.promises.readFile(mPath, 'utf8')) as Mission;
        } catch { /* mission sumiu */ }

        // Verifica se os arquivos aplicados na última iteração continuam no disco.
        const last = run.iterations[run.iterations.length - 1];
        if (last && last.appliedFiles.length > 0) {
            for (const rel of last.appliedFiles) {
                const abs = path.join(this.workspaceRoot, rel.split('/').join(path.sep));
                if (!fs.existsSync(abs)) {
                    return { kind: 'stale', run, reason: `arquivo ${rel} sumiu desde a última iteração` };
                }
            }
        }
        return { kind: 'running', run, mission };
    }

    /** Marca a run atual como interrompida (usada no dispose ou em falha). */
    async markInterrupted(run: RunRecord): Promise<void> {
        const updated: RunRecord = {
            ...run,
            status: 'failed',
            endedAt: new Date().toISOString(),
            lastError: run.lastError || 'interrompida'
        };
        await this.saveCurrentRun(updated);
    }
}
