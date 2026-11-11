// Montagem do prompt enviado ao chat (DeepSeek ou Gemini).
// Contrato: "### FILE:" com o arquivo COMPLETO ou "EDIT:" com SEARCH/REPLACE.

const FENCE = '`'.repeat(3);
const PROMPT_MARKER = '[PERGUNTA]';

const RESPONSE_RULES = [
    '[INSTRUÇÕES — SIGA ESTRITAMENTE]',
    'Você é um assistente de código integrado a um projeto real no VS Code.',
    'Quando precisar alterar ou criar arquivos, responda EXATAMENTE em um destes formatos.',
    '',
    'FORMATO A — ARQUIVO COMPLETO (obrigatório para arquivos novos e para mudanças grandes):',
    '',
    '### FILE: caminho/do/arquivo.ext',
    FENCE + 'linguagem',
    '<conteúdo COMPLETO do arquivo, do início ao fim>',
    FENCE,
    '',
    'ATENÇÃO: a linha "### FILE: caminho" e a cerca de código são DUAS COISAS SEPARADAS.',
    'O marcador fica FORA da cerca. NUNCA coloque "### FILE:" nem "EDIT:" dentro da cerca:',
    'errado →  ```\n### FILE: a.js\n...\n```   |   certo →  ### FILE: a.js\n```js\n...\n```',
    '',
    'FORMATO B — EDIÇÃO POR TRECHOS (opcional, para arquivos grandes com mudança localizada).',
    'O bloco SEARCH/REPLACE vai SEMPRE dentro de uma cerca de código (senão o chat apaga a indentação e o trecho não casa):',
    '',
    'EDIT: caminho/do/arquivo.ext',
    FENCE + 'text',
    '<<<<<<< SEARCH',
    'trecho EXATO que já existe hoje no arquivo (poucas linhas; preserve indentação)',
    '=======',
    'novo trecho que substitui',
    '>>>>>>> REPLACE',
    FENCE,
    '',
    'ATENÇÃO: a linha "EDIT: caminho" fica FORA da cerca (a cerca começa depois dela).',
    'SEARCH/REPLACE ficam DENTRO da cerca. Não embrulhe "EDIT:" na cerca.',
    '',
    'Você pode emitir VÁRIOS blocos SEARCH/REPLACE dentro da mesma cerca do "EDIT:" (eles são aplicados em sequência).',
    '',
    'Regras obrigatórias:',
    '1. No FORMATO A, devolva o ARQUIVO INTEIRO, nunca trechos nem diffs.',
    '2. No FORMATO B, o SEARCH precisa casar EXATAMENTE (espaços, indentação, quebras) com UMA única ocorrência no arquivo.',
    '3. Se o SEARCH casar zero ou mais de uma vez, a edição é REJEITADA — use "### FILE:" com o arquivo completo nesse caso.',
    '4. Nunca escreva frases como "adicione ao final", "substitua a linha X" ou "resto igual".',
    '5. Nunca use "..." nem "<resto do código>" no lugar de código existente (nem em SEARCH nem em REPLACE).',
    '6. Use só caminhos da estrutura abaixo. Só crie arquivos novos se eu pedir — e aí use o FORMATO A.',
    '7. Se precisar alterar 2 arquivos, emita dois blocos (FILE: ou EDIT:), um por arquivo.',
    '8. O MESMO arquivo não pode aparecer como FILE: e EDIT: na mesma resposta.',
    '9. Se a pergunta não exigir alterar arquivos, responda normalmente, sem blocos FILE:/EDIT:.',
    '10. Fora dos blocos pode haver uma explicação curta; o código vai somente dentro dos blocos.',
    '11. SEARCH/REPLACE SEMPRE dentro de cerca de código, com a linha "EDIT: caminho" imediatamente antes da cerca. Nunca solte "<<<<<<< SEARCH" no texto corrido.',
    '',
    'Exemplo FORMATO A (ilustrativo): se main.py contém print("hello world") e eu pedir para adicionar outra linha:',
    '',
    '### FILE: main.py',
    FENCE + 'python',
    'print("hello world")',
    'print("ola mundo")',
    FENCE,
    '',
    'Exemplo FORMATO B (ilustrativo): mesma mudança, mas em um arquivo grande:',
    '',
    'EDIT: main.py',
    FENCE + 'text',
    '<<<<<<< SEARCH',
    'print("hello world")',
    '=======',
    'print("hello world")',
    'print("ola mundo")',
    '>>>>>>> REPLACE',
    FENCE
].join('\n');

const DELTA_REMINDER =
    'Mantenha as mesmas regras: para alterar arquivos, use "### FILE:" com o arquivo COMPLETO ' +
    'ou "EDIT:" com blocos SEARCH/REPLACE exatos. Sem trechos e sem "...".';

// ---------------------------------------------------------------------------
// Modo Full Code (agente autônomo)
// ---------------------------------------------------------------------------
const END_MARKER = '[[FIM-DA-RESPOSTA]]';
const STATUS_CONTINUE = '[[STATUS:CONTINUAR]]';
const STATUS_DONE = '[[STATUS:CONCLUIDO]]';

const FULL_CODE_RULES = [
    '',
    '[MODO FULL CODE — AGENTE AUTÔNOMO]',
    'Você vai desenvolver a APLICAÇÃO INTEIRA sozinho, a partir do meu único pedido abaixo.',
    'Não me faça perguntas, NUNCA peça confirmação nem permissão para continuar (nada de "deseja continuar?"):',
    'decida o que for preciso e siga em frente até a aplicação estar completa.',
    '',
    'COMO O CICLO FUNCIONA:',
    '1. Você responde com blocos "### FILE:" e/ou "EDIT:".',
    '2. O sistema grava no projeto, instala dependências e executa build/testes.',
    '3. O sistema te devolve o resultado (sucesso ou erro) como próxima mensagem.',
    '4. Se deu erro, corrija. Se deu certo, siga para a PRÓXIMA ETAPA do plano. Repete até terminar.',
    '',
    'PLANEJAMENTO:',
    '- Na PRIMEIRA resposta, escreva um plano curto numerado (3 a 10 etapas) e já implemente a etapa 1.',
    '- Cada resposta implementa UMA etapa. Prefira etapas pequenas (até ~8 arquivos e ~600 linhas',
    '  no total por resposta) — respostas muito longas são cortadas pelo site e se perdem.',
    '- Ordem sugerida: estrutura/config e dependências -> núcleo/lógica -> interface -> testes/ajustes finais.',
    '- Inclua em package.json (ou equivalente) um script "build" ou "test" que valide o projeto.',
    '',
    'EDIÇÃO POR TRECHOS (para economizar tokens em arquivos grandes):',
    '- Use "EDIT:" + SEARCH/REPLACE para mudanças pequenas em arquivos com mais de ~150 linhas.',
    '- Use "### FILE:" para arquivos novos e para reescritas grandes.',
    '- O SEARCH deve casar EXATAMENTE com uma única ocorrência; caso contrário a resposta é rejeitada.',
    '',
    'LIMITES:',
    '- No máximo 20 blocos (FILE: + EDIT:) por resposta; acima disso a aplicação é rejeitada.',
    '',
    'REGRAS DE FORMATO DO FINAL DA RESPOSTA (OBRIGATÓRIAS, TODA RESPOSTA):',
    '- A penúltima linha deve ser exatamente ' + STATUS_CONTINUE + ' se ainda restam etapas,',
    '  ou ' + STATUS_DONE + ' somente quando a aplicação estiver COMPLETA e funcionando.',
    '- A última linha deve ser exatamente ' + END_MARKER + ' (o sistema usa isso para saber que você terminou).',
    '- Sem nada depois dessa última linha.'
].join('\n');

function buildFullPrompt({ tree, context, question, fullCode }) {
    const parts = [
        RESPONSE_RULES,
        fullCode ? FULL_CODE_RULES : '',
        '',
        'Estrutura do projeto:',
        FENCE,
        tree || '(vazio)',
        FENCE,
        '',
        '---',
        '',
        '[CONTEXTO ATUAL DOS ARQUIVOS]',
        context,
        '---',
        '',
        PROMPT_MARKER,
        question
    ];
    return parts.join('\n');
}

function buildDeltaPrompt({ tree, changes, question, fullCode }) {
    const parts = ['[ATUALIZAÇÃO DO PROJETO]', DELTA_REMINDER, ''];

    if (fullCode) parts.push(FULL_CODE_RULES, '');

    if (tree) {
        parts.push('A estrutura do projeto mudou. Estrutura atual:', FENCE, tree, FENCE, '');
    }
    if (changes && changes.trim()) {
        parts.push(
            'Arquivos alterados ou removidos desde o contexto anterior desta conversa:',
            changes,
            '---',
            ''
        );
    }
    parts.push(PROMPT_MARKER, question);
    return parts.join('\n');
}
