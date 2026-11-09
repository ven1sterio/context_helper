# Agentes e Papéis

O sistema suporta duas abordagens de autonomia:

1. **Full Code (Agente Único)**
2. **Multiagente (Empresa Virtual)**

## 1. Full Code (Agente Único)
O modelo recebe o objetivo inteiro (ex: "crie uma API em Node") e trabalha em etapas. Ele mesmo planeja, implementa, corrige e conclui. O sistema (`RunManager`) garante que ele não entre em loop e que o build passe.

## 2. Multiagente (Empresa Virtual)
O objetivo é quebrado em um fluxo de trabalho dividido entre papéis. Cada etapa é executada por uma sessão diferente do modelo, com instruções e critérios de aceitação específicos.

### O Fluxo de Trabalho
1. **Analista (`analyst`)**: Lê o projeto e produz um relatório em texto sobre o que precisa ser feito.
2. **Planejador (`planner`)**: Transforma a análise em um plano de 3 a 8 etapas.
3. **Desenvolvedor (`developer`)**: Implementa o código (gera blocos `FILE:` ou `EDIT:`).
4. **Testador (`tester`)**: Cria os testes automatizados.
5. **Revisor (`reviewer`)**: Examina o código gerado. Aprova ou rejeita com base em critérios objetivos. Se rejeitar, a entrega volta para o Desenvolvedor e o Testador.
6. **Integrador (`integrator`)**: Resolve conflitos de merge, ajusta imports e consolida as entregas.
7. **Auditor Final (`final_auditor`)**: Verifica se o objetivo foi cumprido e se todos os critérios passaram.

### Regras de Operação
- O Desenvolvedor **não** cria testes.
- O Testador **não** altera o código de produção apenas para fazer o teste passar. Se o teste falhar, ele relata o problema.
- O Revisor **não** altera arquivos. Ele apenas emite a sentença "APROVADO" ou "REJEITADO".
- Se o Revisor rejeitar uma entrega, a tarefa retorna ao Desenvolvedor e o Revisor volta para a fila de espera (para revisar a próxima submissão).
- Nenhuma tarefa termina com base apenas no texto do modelo; o `auditMission` exige que o build passe e que os critérios de aceitação sejam cumpridos.
