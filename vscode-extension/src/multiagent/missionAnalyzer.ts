import { AcceptanceCriterion } from './agentTypes';

export interface AnalysisResult {
    requirements: string[];
    acceptanceCriteria: AcceptanceCriterion[];
    suggestedTasks: string[];
}

const STOPWORDS = new Set([
    'a', 'o', 'e', 'de', 'da', 'do', 'em', 'para', 'por', 'com', 'sem', 'que',
    'um', 'uma', 'the', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at'
]);

function tokenize(text: string): string[] {
    return text.toLowerCase()
        .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

function newId(prefix: string): string {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

/**
 * Extrai requisitos e critérios de aceitação do objetivo em linguagem natural.
 * Não usa LLM (o modelo ainda não respondeu). Heurísticas simples.
 */
export function analyzeMission(objective: string): AnalysisResult {
    const requirements: string[] = [];
    const criteria: AcceptanceCriterion[] = [];

    const lower = objective.toLowerCase();
    const tokens = tokenize(objective);

    if (/cri[ae]r?\b|crie\b|create|build/.test(lower)) {
        requirements.push('Criar os artefatos descritos no objetivo.');
    }
    if (/implement|adicion|add|feature/.test(lower)) {
        requirements.push('Implementar a funcionalidade solicitada.');
    }
    if (/corrig|fix|bug|erro/.test(lower)) {
        requirements.push('Corrigir o problema descrito.');
    }
    if (/test|teste/.test(lower)) {
        requirements.push('Incluir testes automatizados.');
    }
    if (/api|endpoint|rota/.test(lower)) {
        requirements.push('Expor endpoints/rotas funcionais.');
    }
    if (/frontend|tela|ui|interface|página|pagina|component/.test(lower)) {
        requirements.push('Implementar a interface do usuário.');
    }
    if (requirements.length === 0) {
        requirements.push('Cumprir o objetivo descrito.');
    }

    criteria.push({
        id: newId('crit'),
        description: 'O build/teste do projeto passa (`npm test` ou equivalente).',
        check: 'build'
    });
    criteria.push({
        id: newId('crit'),
        description: 'Um revisor independente aprova os arquivos alterados.',
        check: 'review'
    });
    criteria.push({
        id: newId('crit'),
        description: 'Um auditor final confirma que o objetivo foi cumprido.',
        check: 'audit'
    });

    const suggestedTasks: string[] = ['analisar o projeto atual'];
    if (tokens.length > 0) {
        suggestedTasks.push('planejar as etapas de implementação');
        suggestedTasks.push('implementar a solução');
        suggestedTasks.push('criar/atualizar testes');
        suggestedTasks.push('revisar o código');
        suggestedTasks.push('integrar as entregas');
        suggestedTasks.push('auditar o resultado');
    }

    return { requirements, acceptanceCriteria: criteria, suggestedTasks };
}
