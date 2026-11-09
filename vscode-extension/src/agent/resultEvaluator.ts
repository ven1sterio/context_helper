import { IterationRecord, NextAction } from './agentTypes';

export interface EvaluateInput {
    iteration: IterationRecord;
    modelStatus: 'continue' | 'done' | null;
    guardTripped: boolean;
    guardReason?: string;
    missionComplete: boolean;
    hasNextTask: boolean;
}

export interface EvaluateOutput {
    action: NextAction;
    reason: string;
}

/**
 * Decide o que fazer depois de uma iteração:
 *   - stop:     guard tripou (loop, tentativas esgotadas, etc.)
 *   - retry:    aplicação falhou, build falhou OU modelo pediu CONTINUAR sem arquivos
 *   - done:     modelo CONCLUIDO com build OK (ou missão completa)
 *   - continue: build OK e modelo pediu CONTINUAR (ou CONCLUIDO com próxima tarefa)
 */
export function evaluate(i: EvaluateInput): EvaluateOutput {
    if (i.guardTripped) {
        return { action: 'stop', reason: `IterationGuard: ${i.guardReason || 'limite atingido'}` };
    }
    const it = i.iteration;

    if (it.status === 'apply-failed') {
        return { action: 'retry', reason: 'Falha ao aplicar; reenviar corrigido.' };
    }
    if (it.status === 'parse-error') {
        return { action: 'retry', reason: 'Resposta do modelo não pôde ser interpretada.' };
    }
    if (it.status === 'cancelled') {
        return { action: 'stop', reason: 'Cancelada.' };
    }

    if (it.status === 'no-files') {
        if (i.modelStatus === 'done') {
            return { action: 'done', reason: 'Modelo concluiu sem novos arquivos.' };
        }
        return { action: 'retry', reason: 'Modelo não enviou arquivos; pedir reenvio.' };
    }

    if (it.status === 'applied-build-failed') {
        return { action: 'retry', reason: 'Build falhou; enviar saída ao modelo para correção.' };
    }

    // applied OK
    if (i.modelStatus === 'done') {
        if (!i.hasNextTask) {
            return { action: 'done', reason: 'Última tarefa concluída.' };
        }
        return { action: 'continue', reason: 'Etapa concluída; há próxima tarefa pendente.' };
    }

    if (i.missionComplete) {
        return { action: 'done', reason: 'Missão completa.' };
    }

    return { action: 'continue', reason: 'Build OK; próxima etapa.' };
}
