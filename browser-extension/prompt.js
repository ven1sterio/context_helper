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
    '[[SEARCH]]',
    'trecho EXATO que já existe hoje no arquivo (poucas linhas; preserve indentação)',
    '[[REPLACE]]',
    'novo trecho que substitui',
    '[[END]]',
    FENCE,
    '',
    'Use SEMPRE os marcadores [[SEARCH]], [[REPLACE]] e [[END]], cada um sozinho na sua linha.',
    '(Não use "=======" nem "<<<<<<<": o chat transforma isso em título/HTML e o trecho se perde.)',
    '',
    'ATENÇÃO: a linha "EDIT: caminho" fica FORA da cerca (a cerca começa depois dela).',
    'SEARCH/REPLACE ficam DENTRO da cerca. Não embrulhe "EDIT:" na cerca.',
    '',
    'Você pode emitir VÁRIOS blocos SEARCH/REPLACE dentro da mesma cerca do "EDIT:" (eles são aplicados em sequência).',
    '',
    'FORMATO C — EXCLUIR ARQUIVO INTEIRO (delete):',
    '',
    '### DELETE: caminho/do/arquivo.ext',
    '',
    'Regras do DELETE:',
    '- Use só a linha "### DELETE: caminho". SEM corpo, SEM cerca de código.',
    '- Só apague o ARQUIVO INTEIRO. Para remover um trecho, use EDIT com REPLACE vazio.',
    '- Nunca DELETE pasta. Para limpar uma pasta, emita um DELETE por arquivo.',
    '- Se outro arquivo ainda importa esse, inclua o EDIT correspondente na mesma resposta.',
    '',
    'FORMATO D — MOVER / RENOMEAR ARQUIVO (move/rename):',
    '',
    '### MOVE: caminho/antigo.ext -> caminho/novo.ext',
    '',
    'Regras do MOVE:',
    '- Use "->" (ou "→") entre origem e destino. Mesma linha.',
    '- SEM corpo, SEM cerca de código.',
    '- O destino NÃO pode existir (senão a operação é rejeitada).',
    '- O sistema reescreve os imports dos dependentes que estavam apontando para a origem.',
    '- Se você mesmo já for editar um dependente, não precisa incluir o MOVE nesse arquivo;',
    '  mas o MOVE da origem continua necessário.',
    '',
    'FORMATO E — SUBSTITUIR LINHAS EXATAS (replace_lines — FALLBACK):',
    '',
    '### REPLACE_LINES: caminho/do/arquivo.ext:45-52',
    FENCE + 'linguagem',
    'linha 45',
    'linha 46',
    '...',
    'linha 52 (substituindo as 8 linhas originais)',
    FENCE,
    '',
    'Regras do REPLACE_LINES:',
    '- Use SÓ quando EDIT falhou 2+ vezes no mesmo arquivo e você sabe a linha exata.',
    '- O range é 1-indexado e INCLUSIVO nas duas pontas.',
    '- Linha única: "arquivo.js:45". Várias: "arquivo.js:45-52".',
    '- Só UMA REPLACE_LINES por arquivo. Misturar com FILE:/EDIT:/MOVE:/DELETE: no mesmo arquivo é conflito.',
    '- O conteúdo da cerca substitui TODAS as linhas do range, nem mais nem menos.',
    '- Reproduza a indentação EXATA das linhas vizinhas (que você vê no contexto).',
    '- Se você não tem certeza do número da linha, NÃO use REPLACE_LINES — reenvie com EDIT: ou ### FILE:.',
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
    '11. SEARCH/REPLACE SEMPRE dentro de cerca de código, com a linha "EDIT: caminho" imediatamente antes da cerca. Nunca solte "[[SEARCH]]" no texto corrido.',
    '12. DELETE: só a linha "### DELETE: caminho", sem corpo e sem cerca. Nunca use DELETE para trechos (use EDIT com REPLACE vazio).',
    '13. NUNCA use "### FILE:" junto com "[[SEARCH]]". Se for editar trechos, use OBRIGATORIAMENTE a linha "EDIT: caminho" sozinha, e o bloco SEARCH/REPLACE logo abaixo. Se for o arquivo inteiro, use "### FILE:" e NENHUM marcador SEARCH/REPLACE dentro.',
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
    '[[SEARCH]]',
    'print("hello world")',
    '[[REPLACE]]',
    'print("hello world")',
    'print("ola mundo")',
    '[[END]]',
    FENCE
].join('\n');


const RE_RULES = [
    '',
    'FORMATO F — ENGENHARIA REVERSA DE DLL/EXE (ler, entender, alterar binários):',
    'Você NÃO vê o binário diretamente. Para olhar dentro dele, peça com UMA linha por pedido (sem cerca de código):',
    'REGRA PRINCIPAL: se o usuário pedir para ver, entender, otimizar ou alterar o conteúdo, as funções ou o código de uma',
    'DLL/EXE (ou se você precisar de uma função decompilada), NÃO responda que "não consegue ver" e NÃO liste o que "falta".',
    'Emita os pedidos "### RE:" NESTA MESMA resposta e deixe o sistema executá-los. Comece por functions/strings para localizar',
    'o alvo e depois decompile. O resumo de imports/exports/strings do contexto NÃO é o código: para o código, peça decompile.',
    '',
    '### RE: info Qt6OpenGL.dll                       (formato, arquitetura, seções, imagebase)',
    '### RE: functions Qt6OpenGL.dll filter=Shader limit=50',
    '### RE: decompile Qt6OpenGL.dll NomeDaFuncao     (pseudo-C + quem chama + quem é chamada; aceita 0x endereço)',
    '### RE: disasm Qt6OpenGL.dll 0x180001000 count=40',
    '### RE: xrefs Qt6OpenGL.dll NomeDaFuncao          (quem referencia)',
    '### RE: strings Qt6OpenGL.dll "texto a procurar"  (com as funções que usam a string)',
    '### RE: asm Qt6OpenGL.dll addr=0x180001000 text="nop"   (converte instrução em bytes)',
    '### RE: patch Qt6OpenGL.dll rva=0x1A2B expect="48 89 5C 24 08" write="90 90 90 90 90"',
    '',
    'Regras do RE:',
    '- O sistema executa e devolve o resultado na próxima mensagem. Peça por função, nunca a DLL inteira.',
    '- Binário .NET (gerenciado): o sistema usa o ILSpy. info/functions/strings/patch funcionam; decompile aceita o nome do TIPO',
    '  (Namespace.Classe) e devolve C#; disasm do tipo devolve IL; xrefs e asm não existem para .NET. Para editar a lógica .NET,',
    '  prefira o projeto C# gerado em decompiled/<nome> (comando "Decompilar DLL .NET para projeto C#") e recompilar.',
    '- Máximo de 8 pedidos por resposta. Termine a resposta normalmente com [[STATUS:CONTINUAR]] enquanto estiver investigando.',
    '- O pseudo-C vem do Ghidra: é aproximação (nomes de variáveis inventados, sem PDB não há nomes de funções internas).',
    '  Não trate como código-fonte original e diga quando estiver inferindo.',
    '- Se existir código-fonte (.c/.cpp) do mesmo binário no projeto, prefira editar o código-fonte e recompilar.',
    '- PATCH: write tem que ter o MESMO tamanho de expect. expect é conferido contra o arquivo; se não casar, nada é gravado.',
    '  Por padrão grava uma cópia "nome.patched.dll"; o original fica intocado. O usuário precisa aprovar no VS Code.',
    '  Antes de propor um patch, mostre a função decompilada, o endereço exato e o risco.',
    '- Não misture pedidos RE com blocos FILE:/EDIT: na mesma resposta (os blocos seriam ignorados).'
].join('\n');

function buildReResultPrompt({ text, errors, ignoredFiles }) {
    const parts = ['[RESULTADO DA ENGENHARIA REVERSA]', text || '(sem saída)'];
    if (errors && errors.length) parts.push('', 'Pedidos RE inválidos (corrija a sintaxe):', ...errors.map(e => '- ' + e));
    if (ignoredFiles) parts.push('', 'ATENÇÃO: os blocos FILE:/EDIT: da sua resposta anterior NÃO foram aplicados (não misture com RE). Reenvie depois.');
    parts.push('', 'Continue a investigação ou conclua. Termine com [[STATUS:CONTINUAR]] ou [[STATUS:CONCLUIDO]] e com [[FIM-DA-RESPOSTA]].');
    return parts.join('\n');
}

const DELTA_REMINDER =
    'Mantenha as mesmas regras: para alterar arquivos, use "### FILE:" com o arquivo COMPLETO ' +
    'ou "EDIT:" com blocos SEARCH/REPLACE exatos. Sem trechos e sem "...". ' +
    'Para olhar/alterar binários (.dll/.exe) continue usando as linhas "### RE: operação arquivo ...".';

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
    '- Use "### DELETE: caminho" para excluir um arquivo inteiro (só a linha, sem corpo, sem cerca).',
    '- Use "### MOVE: origem -> destino" para mover/renomear um arquivo (só a linha).',
    '- Use "### REPLACE_LINES: caminho:inicio-fim" só como ÚLTIMO recurso quando EDIT falhar (uma vez por arquivo).',
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
        RE_RULES,
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
