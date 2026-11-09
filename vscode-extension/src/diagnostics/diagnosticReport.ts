import * as vscode from 'vscode';
import { HealthReport, HealthItem } from './healthCheck';

function icon(status: HealthItem['status']): string {
    if (status === 'ok') return '✅';
    if (status === 'warn') return '⚠️';
    return '❌';
}

export function toMarkdown(report: HealthReport, workspaceRoot: string): string {
    const lines: string[] = [];
    lines.push('# Diagnóstico — DeepSeek Context Sync');
    lines.push('');
    lines.push(`_Gerado em ${report.generatedAt}_`);
    lines.push('');
    lines.push(`**Workspace:** \`${workspaceRoot || '(nenhum)'}\``);
    lines.push('');
    lines.push(`**Status geral:** ${icon(report.overall)} ${report.overall.toUpperCase()}`);
    lines.push('');
    lines.push('## Itens');
    lines.push('');
    for (const it of report.items) {
        lines.push(`### ${icon(it.status)} ${it.name}`);
        lines.push('');
        lines.push(it.message);
        if (it.detail) {
            lines.push('');
            lines.push('```');
            lines.push(it.detail);
            lines.push('```');
        }
        lines.push('');
    }
    lines.push('## Como recuperar de problemas comuns');
    lines.push('');
    lines.push('- **Porta 8765 em uso:** feche outras janelas do VS Code com a extensão ativa, ou encerre processos Node antigos.');
    lines.push('- **Token inválido:** no VS Code, `Ctrl+Shift+P` → "DeepSeek Context Sync: Copiar Token", cole no painel do navegador.');
    lines.push('- **graph.json ausente:** rode `graphify . --update` na raiz do projeto.');
    lines.push('- **Build falhando:** verifique `package.json` → `scripts.build`/`test`.');
    lines.push('- **Execução interrompida:** o VS Code pergunta ao abrir — escolha "Retomar" se quiser continuar.');
    lines.push('- **Alterações não aplicam:** confira se o `applyMode` é `partial` (padrão) e se o caminho está dentro do workspace.');
    return lines.join('\n');
}

export function showReport(report: HealthReport, workspaceRoot: string): void {
    const md = toMarkdown(report, workspaceRoot);
    vscode.workspace.openTextDocument({ language: 'markdown', content: md })
        .then(doc => vscode.window.showTextDocument(doc, { preview: true }))
        .then(undefined, err => {
            vscode.window.showErrorMessage('Falha ao abrir o diagnóstico: ' + (err?.message || err));
        });
}
