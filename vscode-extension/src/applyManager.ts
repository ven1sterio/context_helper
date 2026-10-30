import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ApplyResult, PlannedFile, planFiles, countLines, isSuspiciousShrink } from './applyPlan';
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
}

export class ApplyManager implements vscode.TextDocumentContentProvider, vscode.Disposable {
    private proposals = new Map<string, string>();
    private busy = false;
    private abortRequested = false;
    private registration: vscode.Disposable;

    constructor(private workspaceRoot: string) {
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

        const plan = planFiles(input, this.workspaceRoot, abs => this.readFileSync(abs));
        if (!plan.ok) return { status: 'error', message: plan.error };

        this.busy = true;
        this.proposals.clear();
        try {
            const entries = await this.inspect(plan.files);

            if (this.abortRequested) {
                return { status: 'cancelled', message: 'Cancelado pelo usuário.' };
            }

            if (options.auto) {
                await this.backup(entries);
                return await this.write(entries);
            }

            let choice: string | undefined = await vscode.window.showWarningMessage(
                `Aplicar alterações do DeepSeek em ${entries.length} arquivo(s)?`,
                { modal: true, detail: this.describe(entries) },
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
            return await this.write(entries);
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

    private describe(entries: Entry[]): string {
        return entries.map(e => {
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
    }

    /**
     * Grava uma cópia dos arquivos originais antes de aplicar, para permitir
     * desfazer manualmente. Pasta: `.deepseek-sync/backup/<timestamp>/`.
     * Mantém apenas os BACKUP_KEEP backups mais recentes.
     */
    private async backup(entries: Entry[]): Promise<void> {
        const existing = entries.filter(e => e.doc);
        if (existing.length === 0) return;

        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const root = path.join(this.workspaceRoot, BACKUP_DIR);
        const dir = path.join(root, stamp);
        try { await fs.promises.mkdir(dir, { recursive: true }); } catch { return; }

        for (const e of existing) {
            try {
                const target = path.join(dir, e.file.rel.split('/').join(path.sep));
                await fs.promises.mkdir(path.dirname(target), { recursive: true });
                await fs.promises.writeFile(target, e.doc!.getText(), 'utf8');
            } catch { /* ignore */ }
        }

        // Rotação: mantém os N mais recentes.
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
            const right = vscode.Uri.from({ scheme: SCHEME, path: '/proposed/' + e.file.rel });
            const left = e.doc ? e.uri : vscode.Uri.from({ scheme: SCHEME, path: '/empty' });
            this.proposals.set(right.path, e.file.content);
            await vscode.commands.executeCommand(
                'vscode.diff', left, right, `${e.file.rel} ↔ DeepSeek`, { preview: false }
            );
        }
    }

    private async write(entries: Entry[]): Promise<ApplyResult> {
        const edit = new vscode.WorkspaceEdit();

        for (const e of entries) {
            if (e.doc) {
                const full = new vscode.Range(e.doc.positionAt(0), e.doc.positionAt(e.doc.getText().length));
                edit.replace(e.uri, full, e.file.content);
            } else {
                await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(e.file.abs)));
                edit.createFile(e.uri, { ignoreIfExists: true });
                edit.insert(e.uri, new vscode.Position(0, 0), e.file.content);
            }
        }

        const ok = await vscode.workspace.applyEdit(edit);
        if (!ok) return { status: 'error', message: 'O VS Code recusou a edição.' };

        for (const e of entries) {
            const doc = await vscode.workspace.openTextDocument(e.uri);
            if (doc.isDirty) await doc.save();
        }

        const names = entries.map(e => e.file.rel);
        const shown = names.length <= 3
            ? names.join(', ')
            : `${names.slice(0, 3).join(', ')} e mais ${names.length - 3}`;
        vscode.window.showInformationMessage(`✅ DeepSeek: ${names.length} arquivo(s) atualizado(s): ${shown}`);
        return { status: 'applied', message: `${names.length} arquivo(s) atualizado(s).`, files: names };
    }

    dispose() {
        this.registration.dispose();
    }
}
