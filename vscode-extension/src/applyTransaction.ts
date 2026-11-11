import * as fs from 'fs';
import * as path from 'path';
import { PlannedFile } from './applyPlan';

export interface TransactionBackup {
    rel: string;
    abs: string;
    content: string | null; // null = arquivo não existia (vai ser criado)
    /** Preenchido quando a operação é MOVE — para reverter com rename de volta. */
    moveFrom?: { rel: string; abs: string };
}

export interface TransactionResult {
    ok: boolean;
    applied: string[];
    error?: string;
    /** Arquivos efetivamente restaurados após rollback. */
    restored?: string[];
}

/**
 * Aplica um conjunto de arquivos como transação.
 *
 *   1) Guarda o conteúdo original de todos os arquivos existentes (em memória).
 *   2) Escreve cada arquivo via `writeFile`.
 *   3) Após cada escrita, chama `verifyFile`. Se qualquer verificação falhar,
 *      restaura todos os arquivos já escritos e devolve erro.
 *
 * O backup permanente continua sendo feito pelo ApplyManager em
 * `.deepseek-sync/backup/<timestamp>/`; esta transação só garante que a
 * aplicação em si seja atômica (ou tudo vai, ou tudo volta).
 */
export class ApplyTransaction {
    constructor(
        private workspaceRoot: string,
        private writeFile: (abs: string, content: string) => Promise<void>,
        private verifyFile: (abs: string, expectedContent: string) => Promise<boolean> = async () => true,
        private deleteFile: (abs: string) => Promise<void> = async (abs) => { await fs.promises.unlink(abs); },
        private moveFile: (fromAbs: string, toAbs: string) => Promise<void> = async (fromAbs, toAbs) => {
            await fs.promises.rename(fromAbs, toAbs);
        }
    ) {}

    async run(files: PlannedFile[]): Promise<TransactionResult> {
        if (files.length === 0) return { ok: true, applied: [] };

        // 1) snapshot em memória
        const backups: TransactionBackup[] = [];
        for (const f of files) {
            if (f.moveFrom) {
                // MOVE: guardamos a origem para rollback via rename de volta.
                backups.push({ rel: f.rel, abs: f.abs, content: null, moveFrom: f.moveFrom });
                continue;
            }
            let content: string | null = null;
            try {
                if (fs.existsSync(f.abs)) content = fs.readFileSync(f.abs, 'utf8');
            } catch {
                content = null;
            }
            backups.push({ rel: f.rel, abs: f.abs, content });
        }

        // 2) aplica e verifica
        const applied: string[] = [];
        try {
            for (const f of files) {
                if (f.delete) {
                    await this.deleteFile(f.abs);
                    applied.push(f.rel);
                    continue;
                }
                if (f.moveFrom) {
                    if (fs.existsSync(f.abs)) throw new Error(`destino já existe: ${f.rel}`);
                    try { await fs.promises.mkdir(path.dirname(f.abs), { recursive: true }); } catch { /* ignore */ }
                    await this.moveFile(f.moveFrom.abs, f.abs);
                    applied.push(f.rel);
                    continue;
                }
                try {
                    await fs.promises.mkdir(path.dirname(f.abs), { recursive: true });
                } catch { /* diretório já existe */ }
                await this.writeFile(f.abs, f.content);
                applied.push(f.rel);
                const ok = await this.verifyFile(f.abs, f.content);
                if (!ok) throw new Error(`verificação falhou em ${f.rel}`);
            }
            return { ok: true, applied };
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            const restored = await this.restore(backups);
            return {
                ok: false,
                applied,
                error: `${message}; ${restored.length} arquivo(s) restaurado(s)`,
                restored
            };
        }
    }

    private async restore(backups: TransactionBackup[]): Promise<string[]> {
        const restored: string[] = [];
        for (const b of backups) {
            try {
                if (b.moveFrom) {
                    // Desfaz o move SÓ se ele realmente aconteceu.
                    // Se a origem ainda existe, o move falhou logo antes e o
                    // destino existente é o original — não podemos sobrescrevê-lo!
                    if (!fs.existsSync(b.moveFrom.abs) && fs.existsSync(b.abs)) {
                        await this.moveFile(b.abs, b.moveFrom.abs);
                    }
                } else if (b.content === null) {
                    if (fs.existsSync(b.abs)) await fs.promises.unlink(b.abs);
                } else {
                    await this.writeFile(b.abs, b.content);
                }
                restored.push(b.rel);
            } catch { /* não há muito o que fazer aqui */ }
        }
        return restored;
    }
}
