import { AgentRole, TaskContract } from './agentTypes';

const FENCE = '`'.repeat(3);
const STATUS_CONTINUE = '[[STATUS:CONTINUAR]]';
const STATUS_DONE = '[[STATUS:CONCLUIDO]]';
const END_MARKER = '[[FIM-DA-RESPOSTA]]';
const CONTRACT_MARKER = '[CONTRATO-DE-TAREFA]';

const BASE_RULES = [
    'Você é um agente especializado dentro de uma empresa virtual de desenvolvimento.',
    'Sua tarefa é UM papel específico desta missão. Não tente fazer o trabalho de outros papéis.',
    'Responda no formato exigido pelo contrato (FILE/EDIT ou texto puro).',
    'Nunca invente resultados que você não pode verificar.',
    `Toda resposta DEVE terminar com ${STATUS_CONTINUE} (se ainda restam passos do SEU papel) ou ${STATUS_DONE} (se você terminou seu papel), seguido de ${END_MARKER} na última linha.`,
    '',
    'FORMATO A — ARQUIVO COMPLETO (obrigatório para arquivos novos e mudanças grandes):',
    '### FILE: caminho/do/arquivo.ext',
    FENCE + 'linguagem',
    '<conteúdo COMPLETO>',
    FENCE,
    '',
    'FORMATO B — EDIÇÃO POR TRECHOS (arquivos grandes, mudança localizada):',
    'EDIT: caminho/do/arquivo.ext',
    FENCE + 'text',
    '[[SEARCH]]',
    'trecho exato existente (poucas linhas)',
    '[[REPLACE]]',
    'novo trecho',
    '[[END]]',
    FENCE,
    '',
    'Se precisar só de TEXTO (análise/plano/nota), responda em texto normal, sem blocos FILE/EDIT.'
].join('\n');

const ROLE_INSTRUCTIONS: Record<AgentRole, string> = {
    mission_director:
        'Você é o Diretor. Não implementa código. Apenas revisa o plano e marca CONCLUÍDO ' +
        'quando o objetivo foi atingido ou CONTINUAR quando ainda há etapas. Seja conciso.',
    analyst:
        'Você é o Analista. Leia o projeto, identifique módulos envolvidos, dependências ' +
        'e riscos. Produza um breve relatório em TEXTO (sem arquivos): módulos, pontos de atenção, ' +
        'o que precisa ser alterado para cumprir o objetivo.',
    planner:
        'Você é o Planejador. Transforme o objetivo em 3 a 8 etapas pequenas, numeradas e verificáveis. ' +
        'Cada etapa deve indicar: o que será feito, quais arquivos provavelmente serão tocados, ' +
        'e como validar. Responda em TEXTO (sem arquivos).',
    developer:
        'Você é o Desenvolvedor. Implemente a etapa descrita, usando FILE: e/ou EDIT: conforme ' +
        'o tamanho. Não crie arquivos de teste (o Testador fará isso). Prefira alterações pequenas.',
    reviewer:
        'Você é o Revisor. NÃO altera arquivos. Avalie a entrega recebida contra os critérios de ' +
        'aceitação. Responda em TEXTO: no PRIMEIRO caracter, "APROVADO" ou "REJEITADO", seguido ' +
        'de pontos específicos. Se rejeitar, diga exatamente o que precisa mudar.',
    tester:
        'Você é o Testador. Crie/atualize testes automatizados que validem a entrega do Desenvolvedor. ' +
        'Use FILE: para os arquivos de teste. NÃO altere código de produção para "fazer o teste passar"; ' +
        'se algo falhar, relate em TEXTO e marque CONCLUIDO com uma nota do problema.',
    integrator:
        'Você é o Integrador. Consolide as entregas das etapas anteriores em um conjunto coerente. ' +
        'Use FILE:/EDIT: para resolver conflitos aparentes (imports, exports, nomes). Não invente ' +
        'funcionalidade nova; apenas integre.',
    final_auditor:
        'Você é o Auditor final. NÃO altera arquivos. Verifique se cada critério de aceitação foi ' +
        'cumprido, com base nas entregas. Responda em TEXTO: primeira palavra "CUMPRIDO" ou ' +
        '"NAO_CUMPRIDO", seguida de evidência objetiva.'
};

export function buildRolePrompt(contract: TaskContract, currentFiles: string): string {
    const parts: string[] = [];
    parts.push(BASE_RULES);
    parts.push('');
    parts.push(`--- SEU PAPEL: ${contract.role.toUpperCase()} ---`);
    parts.push(ROLE_INSTRUCTIONS[contract.role]);
    parts.push('');
    parts.push(CONTRACT_MARKER);
    parts.push(JSON.stringify({
        taskId: contract.taskId,
        missionId: contract.missionId,
        kind: contract.kind,
        role: contract.role,
        objective: contract.objective,
        acceptanceCriteria: contract.acceptanceCriteria.map(c => ({
            id: c.id, description: c.description, check: c.check
        })),
        outputFormat: contract.outputFormat,
        constraints: contract.context.constraints
    }, null, 2));
    parts.push('');

    if (contract.context.files.length > 0) {
        parts.push('--- ARQUIVOS RELEVANTES ---');
        parts.push('Você pode ler/alterar estes caminhos:');
        for (const f of contract.context.files) parts.push('  ' + f);
        parts.push('');
    }

    if (contract.context.previousDeliverables && contract.context.previousDeliverables.length > 0) {
        parts.push('--- ENTREGAS ANTERIORES (referência) ---');
        for (const d of contract.context.previousDeliverables) parts.push('  ' + d);
        parts.push('');
    }

    parts.push('--- ESTADO ATUAL DO PROJETO (contexto) ---');
    parts.push(currentFiles || '(vazio)');
    parts.push('');
    parts.push(`Termine sempre com ${STATUS_CONTINUE} ou ${STATUS_DONE} e depois ${END_MARKER}.`);
    return parts.join('\n');
}
