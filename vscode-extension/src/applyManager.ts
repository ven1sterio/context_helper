import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ApplyResult, PlannedFile, planFiles, countLines, isSuspiciousShrink } from './applyPlan';
import { ApplyTransaction } from './applyTransaction';
import { looksSensitive } from './pathRules';

const SCHEME = 'deepseek-proposed';
const BACKUP_DIR = '.deepseek-sync/backup';
const BACKUP_KEEP = 10;

interface Entry {
    file: PlannedFile;
    uri: vscode.Uri;
    doc?: vscode.TextDocument;
    oldLines: number;
    newLines: number;
}

export interface ApplyOptions {
    auto?: boolean;
    /**
     * Conflitos detectados pelo wsServer (arquivos que mudaram desde o envio
     * do contexto). São exibidos no diálogo e no resultado.
     */
    conflicts?: string[];
}

export class ApplyManager implements vscode.TextDocumentContentProvider, vscode.Disposable {
    private proposals = new Map<string, string>();
    private busy = false;
    private abortRequested = false;
    private registration: vscode.Disposable;

    constructor(
        private workspaceRoot: string,
        private hooks: { findDependents?: (rel: string) => string[]; allFilePaths?: () => ReadonlySet<string> } = {}
    ) {
        this.registration = vscode.workspace.registerTextDocumentContentProvider(SCHEME, this);
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.proposals.get(uri.path) ?? '';
    }

    requestAbort(): void {
        this.abortRequested = true;
    }

    private readFileSync(abs: string): string | undefined {
        try { return fs.readFileSync(abs, 'utf8'); }
        catch { return undefined; }
    }

    async apply(input: unknown, options: ApplyOptions = {}): Promise<ApplyResult> {
        if (this.busy) {
            return { status: 'error', message: 'Já existe uma aplicação aguardando confirmação no VS Code.' };
        }

        this.abortRequested = false;

        const mode = vscode.workspace.getConfiguration('deepseekContextSync').get<string>('applyMode', 'partial');
        const partial = !options.auto && mode === 'partial';
        const plan = planFiles(input, this.workspaceRoot, abs => this.readFileSync(abs), {
            partial,
            allowUnfenced: !options.auto,
            findDependents: this.hooks.findDependents,
            allFilePaths: this.hooks.allFilePaths
        });
        if (!plan.ok) return { status: 'error', message: plan.error };
        const { skipped } = plan;

        // Conflitos vêm do wsServer e entram como avisos no diálogo.
        const conflictWarnings = (options.conflicts ?? []).map(c => `⚠️ conflito: ${c}`);
        const warnings = [...plan.warnings, ...conflictWarnings];

        this.busy = true;
        this.proposals.clear();
        try {
            const entries = await this.inspect(plan.files);

            if (this.abortRequested) {
                return { status: 'cancelled', message: 'Cancelado pelo usuário.' };
            }

            if (options.auto) {
                await this.backup(entries);
                return await this.write(entries, skipped, warnings);
            }

            const deleteCount = entries.filter(e => e.file.delete).length;
            const moveCount = entries.filter(e => e.file.moveFrom).length;
            const writeCount = entries.length - deleteCount - moveCount;
            const parts: string[] = [];
            if (writeCount > 0) parts.push(`${writeCount} alteração(ões)`);
            if (deleteCount > 0) parts.push(`🗑️ excluir ${deleteCount}`);
            if (moveCount > 0) parts.push(`📦 mover ${moveCount}`);
            let title: string;
            if (moveCount > 0 || deleteCount > 0) {
                title = `Aplicar: ${parts.join(' + ')}?`;
            } else {
                title = skipped.length > 0
                    ? `Aplicar ${entries.length} arquivo(s)? ${skipped.length} edição(ões) NÃO casaram e serão ignoradas.`
                    : `Aplicar alterações do DeepSeek em ${entries.length} arquivo(s)?`;
            }
            let choice: string | undefined = await vscode.window.showWarningMessage(
                title,
                { modal: true, detail: this.describe(entries, skipped, warnings) },
                'Aplicar',
                'Revisar diff primeiro'
            );

            if (choice === 'Revisar diff primeiro') {
                await this.openDiffs(entries);
                choice = await vscode.window.showInformationMessage(
                    'Revise o diff nas abas abertas. Aplicar as alterações?',
                    'Aplicar',
                    'Cancelar'
                );
            }

            if (choice !== 'Aplicar') {
                return { status: 'cancelled', message: 'Alteração cancelada.' };
            }
            if (this.abortRequested) {
                return { status: 'cancelled', message: 'Cancelado pelo usuário.' };
            }

            await this.backup(entries);
            return await this.write(entries, skipped, warnings);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return { status: 'error', message };
        } finally {
            this.busy = false;
        }
    }

    private async inspect(files: PlannedFile[]): Promise<Entry[]> {
        const entries: Entry[] = [];
        for (const file of files) {
            const uri = vscode.Uri.file(file.abs);

            let stat: vscode.FileStat | undefined;
            try { stat = await vscode.workspace.fs.stat(uri); } catch { stat = undefined; }
            if (stat && (stat.type & vscode.FileType.Directory)) {
                throw new Error(`${file.rel} é uma pasta.`);
            }

            let doc: vscode.TextDocument | undefined;
            if (stat) {
                try { doc = await vscode.workspace.openTextDocument(uri); }
                catch { throw new Error(`Não foi possível abrir ${file.rel} como texto.`); }
            }

            entries.push({
                file, uri, doc,
                oldLines: doc ? countLines(doc.getText()) : 0,
                newLines: countLines(file.content)
            });
        }
        return entries;
    }

    private describe(entries: Entry[], skipped: string[] = [], warnings: string[] = []): string {
        const files = entries.map(e => {
            if (e.file.delete) {
                return `• 🗑️ ${e.file.rel} — DELETAR${e.doc ? ` (${e.oldLines} linhas)` : ''}`;
            }
            if (e.file.moveFrom) {
                return `• 📦 ${e.file.moveFrom.rel} → ${e.file.rel} — MOVER`;
            }
            if (e.file.replaceLines) {
                const r = e.file.replaceLines;
                const rangeLabel = r.start === r.end ? `linha ${r.start}` : `linhas ${r.start}-${r.end}`;
                return `• ✂️ ${e.file.rel} — REPLACE_LINES ${rangeLabel} (${e.oldLines} → ${e.newLines} linhas)`;
            }
            if (!e.doc) return `• ${e.file.rel} — NOVO (${e.newLines} linhas)`;
            let line = `• ${e.file.rel} — ${e.oldLines} → ${e.newLines} linhas`;
            const name = e.file.rel.split('/').pop() ?? '';
            if (looksSensitive(name)) {
                line += '\n    ⚠️ arquivo sensível (pode conter segredos): confira o diff';
            }
            if (isSuspiciousShrink(e.oldLines, e.newLines)) {
                line += '\n    ⚠️ o arquivo encolheu muito: o modelo pode ter omitido trechos';
            }
            if (e.doc.isDirty) {
                line += '\n    ⚠️ há alterações não salvas no editor que serão substituídas';
            }
            return line;
        }).join('\n');
        const extra: string[] = [];
        if (skipped.length) extra.push('⛔ Ignoradas (não casaram):', ...skipped.map(m => `  - ${m}`));
        if (warnings.length) extra.push('ℹ️ Avisos:', ...warnings.map(m => `  - ${m}`));
        return extra.length ? `${files}\n\n${extra.join('\n')}` : files;
    }

    private async backup(entries: Entry[]): Promise<void> {
        // Backup de qualquer arquivo que será sobrescrito, excluído ou MOVIDO.
        // Para MOVE, a origem é quem precisa ser salva (o destino não existe).
        const existing = entries.filter(e => {
            const pathToSave = e.file.moveFrom ? e.file.moveFrom.abs : e.file.abs;
            if (e.doc) return true;
            if (!e.file.delete && !e.file.moveFrom) return false;
            try { return fs.existsSync(pathToSave); } catch { return false; }
        });
        if (existing.length === 0) return;

        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const root = path.join(this.workspaceRoot, BACKUP_DIR);
        const dir = path.join(root, stamp);
        try { await fs.promises.mkdir(dir, { recursive: true }); } catch { return; }

        for (const e of existing) {
            try {
                if (e.file.moveFrom) {
                    // Backup da origem (nome = caminho original).
                    const target = path.join(dir, e.file.moveFrom.rel.split('/').join(path.sep));
                    await fs.promises.mkdir(path.dirname(target), { recursive: true });
                    await fs.promises.copyFile(e.file.moveFrom.abs, target);
                    continue;
                }
                const target = path.join(dir, e.file.rel.split('/').join(path.sep));
                await fs.promises.mkdir(path.dirname(target), { recursive: true });
                if (e.doc) {
                    await fs.promises.writeFile(target, e.doc.getText(), 'utf8');
                } else {
                    await fs.promises.copyFile(e.file.abs, target);
                }
            } catch { /* ignore */ }
        }

        try {
            const all = (await fs.promises.readdir(root))
                .filter(n => /^\d{4}-/.test(n))
                .sort();
            const excess = all.length - BACKUP_KEEP;
            for (let i = 0; i < excess; i++) {
                const stale = path.join(root, all[i]);
                await fs.promises.rm(stale, { recursive: true, force: true });
            }
        } catch { /* ignore */ }
    }

    private async openDiffs(entries: Entry[]) {
        for (const e of entries) {
            if (e.file.delete || e.file.moveFrom) continue;
            const right = vscode.Uri.from({ scheme: SCHEME, path: '/proposed/' + e.file.rel });
            const left = e.doc ? e.uri : vscode.Uri.from({ scheme: SCHEME, path: '/empty' });
            this.proposals.set(right.path, e.file.content);
            await vscode.commands.executeCommand(
                'vscode.diff', left, right, `${e.file.rel} ↔ DeepSeek`, { preview: false }
            );
        }
    }

    /**
     * Aplica o plano como transação. Se alguma escrita falhar, todos os
     * arquivos já gravados são restaurados (rollback) e devolve erro.
     * O backup em `.deepseek-sync/backup/` continua sendo feito antes.
     */
    private async write(entries: Entry[], skipped: string[] = [], warnings: string[] = []): Promise<ApplyResult> {
        const writeFn = async (abs: string, content: string) => {
            const uri = vscode.Uri.file(abs);
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(abs)));
            let doc: vscode.TextDocument | undefined;
            try { doc = await vscode.workspace.openTextDocument(uri); } catch { doc = undefined; }
            if (doc) {
                const edit = new vscode.WorkspaceEdit();
                const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
                edit.replace(uri, full, content);
                const ok = await vscode.workspace.applyEdit(edit);
                if (!ok) throw new Error(`applyEdit recusou ${abs}`);
                if (doc.isDirty) {
                    const saved = await doc.save();
                    if (!saved) throw new Error(`save falhou em ${abs}`);
                }
            } else {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
            }
        };

        const verifyFn = async (abs: string, expected: string) => {
            try {
                const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(abs));
                const actual = Buffer.from(bytes).toString('utf8');
                // Comparação tolerante: normaliza EOL (CRLF vs LF) e remove trailing whitespace.
                // Isso evita que o auto-formatador do VS Code quebre a aplicação por diferenças
                // invisíveis de espaços no fim das linhas.
                const normalize = (s: string) => s.replace(/\r\n/g, '\n').trimEnd();
                return normalize(actual) === normalize(expected);
            } catch {
                return false;
            }
        };

        // Passa pelo FileSystem do VS Code em vez de fs.unlink direto — assim
        // respeita a abstração (remote workspaces, virtual FS) e falha de forma
        // consistente quando o arquivo está aberto e dirty.
        const deleteFn = async (abs: string) => {
            await vscode.workspace.fs.delete(vscode.Uri.file(abs), { useTrash: false, recursive: false });
        };

        const moveFn = async (fromAbs: string, toAbs: string) => {
            await vscode.workspace.fs.rename(
                vscode.Uri.file(fromAbs),
                vscode.Uri.file(toAbs),
                { overwrite: false }
            );
        };

        const tx = new ApplyTransaction(this.workspaceRoot, writeFn, verifyFn, deleteFn, moveFn);
        const result = await tx.run(entries.map(e => e.file));
        if (!result.ok) {
            return {
                status: 'error',
                message: result.error || 'Transação falhou.',
                files: [],
                skipped,
                warnings
            };
        }

        const names = result.applied;
        const deletedSet = new Set(entries.filter(e => e.file.delete).map(e => e.file.rel));
        const deleted = names.filter(n => deletedSet.has(n));
        const moveMap = new Map<string, string>(); // destRel → fromRel
        for (const e of entries) {
            if (e.file.moveFrom) moveMap.set(e.file.rel, e.file.moveFrom.rel);
        }
        const moved: Array<{ from: string; to: string }> = [];
        for (const n of names) {
            const fromRel = moveMap.get(n);
            if (fromRel) moved.push({ from: fromRel, to: n });
        }
        const updatedCount = names.length - deleted.length - moved.length;
        const summaryParts: string[] = [];
        if (updatedCount > 0) summaryParts.push(`${updatedCount} atualizado(s)`);
        if (deleted.length > 0) summaryParts.push(`🗑️ ${deleted.length} excluído(s)`);
        if (moved.length > 0) summaryParts.push(`📦 ${moved.length} movido(s)`);
        const summary = summaryParts.join(', ') || 'nada alterado';

        const shown = names.length <= 3
            ? names.join(', ')
            : `${names.slice(0, 3).join(', ')} e mais ${names.length - 3}`;
        vscode.window.showInformationMessage(`✅ DeepSeek: ${summary}: ${shown}`);
        if (skipped.length) {
            vscode.window.showWarningMessage(`DeepSeek: ${skipped.length} edição(ões) ignorada(s):\n${skipped.join('\n')}`);
        }
        if (warnings.length) {
            vscode.window.showWarningMessage(`DeepSeek: ${warnings.length} aviso(s):\n${warnings.join('\n')}`);
        }
        const tail = skipped.length ? ` ⚠️ ${skipped.length} edição(ões) ignorada(s): ${skipped.join(' | ')}` : '';
        return {
            status: 'applied',
            message: `${summary}.${tail}`,
            files: names,
            deleted: deleted.length > 0 ? deleted : undefined,
            moved: moved.length > 0 ? moved : undefined,
            skipped,
            warnings
        };
    }

    dispose() {
        this.registration.dispose();
    }
}
