import {
    AgentRole, AcceptanceCriterion, TaskKind, TaskPlanItem
} from './agentTypes';

export interface DecomposeInput {
    objective: string;
    requirements: string[];
    acceptanceCriteria: AcceptanceCriterion[];
    suggestedTasks?: string[];
}

function newId(prefix: string): string {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

interface TaskSpec {
    kind: TaskKind;
    role: AgentRole;
    title: string;
    objective: string;
}

const BASE_FLOW: TaskSpec[] = [
    { kind: 'analysis', role: 'analyst', title: 'Analisar projeto', objective: 'Ler o projeto e mapear módulos, dependências e riscos relevantes ao objetivo.' },
    { kind: 'plan', role: 'planner', title: 'Planejar etapas', objective: 'Produzir um plano curto (3 a 8 etapas) para cumprir o objetivo.' },
    { kind: 'implementation', role: 'developer', title: 'Implementar', objective: 'Implementar as etapas planejadas, gerando os arquivos necessários.' },
    { kind: 'test', role: 'tester', title: 'Criar testes', objective: 'Criar ou atualizar testes automatizados que validem a entrega.' },
    { kind: 'review', role: 'reviewer', title: 'Revisar entrega', objective: 'Revisar os arquivos alterados contra os critérios de aceitação.' },
    { kind: 'integration', role: 'integrator', title: 'Integrar entregas', objective: 'Consolidar as entregas, resolver conflitos e aplicar as mudanças finais.' },
    { kind: 'audit', role: 'final_auditor', title: 'Auditar missão', objective: 'Verificar que o objetivo original foi cumprido com evidências.' }
];

export function decompose(input: DecomposeInput): TaskPlanItem[] {
    const tasks: TaskPlanItem[] = [];
    let prevId: string | null = null;
    const total = BASE_FLOW.length;

    BASE_FLOW.forEach((spec, i) => {
        const taskId = newId('task');
        const acceptance: AcceptanceCriterion[] = [];
        if (spec.kind === 'implementation' || spec.kind === 'test') {
            acceptance.push(...input.acceptanceCriteria.filter(c => c.check === 'build'));
        }
        if (spec.kind === 'review') {
            acceptance.push(...input.acceptanceCriteria.filter(c => c.check === 'review'));
        }
        if (spec.kind === 'audit') {
            acceptance.push(...input.acceptanceCriteria.filter(c => c.check === 'audit'));
        }

        const objective = spec.objective +
            (input.requirements.length > 0
                ? '\n\nRequisitos:\n' + input.requirements.map(r => '- ' + r).join('\n')
                : '') +
            `\n\n(Tarefa ${i + 1} de ${total})`;

        tasks.push({
            taskId,
            kind: spec.kind,
            role: spec.role,
            title: spec.title,
            objective,
            dependsOn: prevId ? [prevId] : [],
            status: 'pending',
            attempts: 0,
            acceptanceCriteria: acceptance,
            deliverableIds: [],
            reviewIds: []
        });
        prevId = taskId;
    });

    return tasks;
}

/**
 * Retorna a próxima task pronta.
 * BUGFIX 1: Inclui `review_rejected` no retry.
 * BUGFIX 2: Considera `awaiting_review` como pronto para liberar a fila
 * (permite que o Tester rode antes do Reviewer terminar).
 */
export function nextReady(tasks: TaskPlanItem[]): TaskPlanItem | null {
    const done = new Set(tasks.filter(t => t.status === 'accepted' || t.status === 'awaiting_review').map(t => t.taskId));
    for (const t of tasks) {
        if (t.status !== 'pending' && t.status !== 'review_rejected') continue;
        if (t.dependsOn.every(d => done.has(d))) return t;
    }
    return null;
}

export function allFinished(tasks: TaskPlanItem[]): boolean {
    return tasks.every(t => t.status === 'accepted' || t.status === 'failed');
}
