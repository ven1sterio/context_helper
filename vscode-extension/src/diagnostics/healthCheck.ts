import * as fs from 'fs';
import * as path from 'path';

export type HealthStatus = 'ok' | 'warn' | 'error';

export interface HealthItem {
    name: string;
    status: HealthStatus;
    message: string;
    detail?: string;
}

export interface HealthReport {
    overall: HealthStatus;
    items: HealthItem[];
    generatedAt: string;
}

export interface HealthCheckInput {
    workspaceRoot: string;
    hasContextManager: boolean;
    hasIndexer: boolean;
    hasWsServer: boolean;
    hasGraph?: boolean;
    hasMemory?: boolean;
    hasAgent?: boolean;
    hasMultiAgent?: boolean;
}

export function runHealthCheck(input: HealthCheckInput): HealthReport {
    const items: HealthItem[] = [];

    if (!input.workspaceRoot) {
        items.push({ name: 'workspace', status: 'error', message: 'Nenhuma pasta aberta no VS Code.' });
    } else if (!fs.existsSync(input.workspaceRoot)) {
        items.push({ name: 'workspace', status: 'error', message: 'Workspace não existe no disco: ' + input.workspaceRoot });
    } else {
        items.push({ name: 'workspace', status: 'ok', message: 'Workspace: ' + input.workspaceRoot });
    }

    items.push({
        name: 'contextManager',
        status: input.hasContextManager ? 'ok' : 'error',
        message: input.hasContextManager
            ? 'ContextManager inicializado.'
            : 'ContextManager NÃO inicializado.'
    });
    items.push({
        name: 'indexer',
        status: input.hasIndexer ? 'ok' : 'error',
        message: input.hasIndexer
            ? 'Indexer inicializado.'
            : 'Indexer NÃO inicializado.'
    });
    items.push({
        name: 'wsServer',
        status: input.hasWsServer ? 'ok' : 'error',
        message: input.hasWsServer
            ? 'WsServer inicializado (127.0.0.1:8765).'
            : 'WsServer NÃO inicializado.'
    });

    if (input.workspaceRoot) {
        const graphPath = path.join(input.workspaceRoot, 'graphify-out', 'graph.json');
        if (fs.existsSync(graphPath)) {
            const stat = fs.statSync(graphPath);
            items.push({
                name: 'graph',
                status: 'ok',
                message: 'graph.json encontrado.',
                detail: `${(stat.size / 1024).toFixed(1)} KB, modificado ${new Date(stat.mtimeMs).toISOString()}`
            });
        } else {
            items.push({
                name: 'graph',
                status: 'warn',
                message: 'graph.json NÃO encontrado (o seletivo funciona, só sem o apoio do grafo).',
                detail: 'Rode "graphify . --update" na raiz do projeto para gerar.'
            });
        }

        const memoryDir = path.join(input.workspaceRoot, '.deepseek-sync', 'memory');
        if (fs.existsSync(memoryDir)) {
            try {
                const files = fs.readdirSync(memoryDir);
                items.push({
                    name: 'memory',
                    status: files.length >= 7 ? 'ok' : 'warn',
                    message: `${files.length} arquivo(s) em .deepseek-sync/memory/.`,
                    detail: files.join(', ')
                });
            } catch {
                items.push({ name: 'memory', status: 'warn', message: 'Não consegui listar a memória.' });
            }
        } else {
            items.push({
                name: 'memory',
                status: 'warn',
                message: 'Pasta .deepseek-sync/memory/ ausente.',
                detail: 'Ela é criada na ativação se o workspace estiver vazio.'
            });
        }

        try {
            const pkgPath = path.join(input.workspaceRoot, 'package.json');
            if (fs.existsSync(pkgPath)) {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                const hasBuild = !!(pkg.scripts && (pkg.scripts.build || pkg.scripts.compile || pkg.scripts.test));
                items.push({
                    name: 'build',
                    status: hasBuild ? 'ok' : 'warn',
                    message: hasBuild
                        ? 'Script build/compile/test encontrado no package.json.'
                        : 'Nenhum script build/compile/test no package.json (Full Code não terá como validar).'
                });
            } else {
                items.push({
                    name: 'build',
                    status: 'warn',
                    message: 'Sem package.json na raiz (build/teste automático indisponível).'
                });
            }
        } catch { /* skip */ }
    }

    items.push({
        name: 'fullCodeAgent',
        status: input.hasAgent ? 'ok' : 'warn',
        message: input.hasAgent
            ? 'RunManager do Full Code inicializado.'
            : 'Full Code NÃO inicializado.'
    });
    items.push({
        name: 'multiagent',
        status: input.hasMultiAgent ? 'ok' : 'warn',
        message: input.hasMultiAgent
            ? 'Multiagente inicializado.'
            : 'Multiagente NÃO inicializado.'
    });

    const overall: HealthStatus = items.some(i => i.status === 'error')
        ? 'error'
        : items.some(i => i.status === 'warn') ? 'warn' : 'ok';

    return { overall, items, generatedAt: new Date().toISOString() };
}
