# Arquitetura — DeepSeek Context Sync 2.0

O projeto é dividido em duas metades que se comunicam por WebSocket (porta 8765):

- **`vscode-extension/`** — O cérebro. Executa no VS Code. Lê o projeto, indexa arquivos, aplica edições, roda build/testes e orquestra a inteligência dos agentes.
- **`browser-extension/`** — Os olhos e as mãos. Executa no Chrome/Edge. Interage com a interface web do DeepSeek, Gemini ou ChatGPT, envia prompts, lê respostas e clica em botões.

Nenhuma API paga é utilizada. Tudo depende de automação da página (DOM).

## Módulos do VS Code (`vscode-extension/src/`)

### Núcleo
- `extension.ts` — Ponto de entrada. Ativa os managers, conecta o servidor WebSocket e configura as dependências.
- `wsServer.ts` — Servidor WebSocket local. Recebe mensagens do navegador, valida segurança, roteia para os managers e devolve respostas.
- `contextManager.ts` — Varre a pasta do projeto. Monta a "tree" (estrutura de pastas), os deltas (o que mudou) e o contexto completo.
- `indexer.ts` — Analisa o código em busca de símbolos, imports e dependências. Cria o `.deepseek-sync/index.json`.
- `applyPlan.ts` — Valida blocos `FILE` e `EDIT` (SEARCH/REPLACE) vindos do modelo antes de tocar no disco.
- `applyManager.ts` — Aplica as edições no disco com confirmação do usuário, backups automáticos e rollback (via `applyTransaction`).
- `taskRunner.ts` — Executa comandos de build e teste no terminal integrado do VS Code.
- `stateManager.ts` — Mantém o `state.md`, o diário de bordo do projeto.

### Segurança (Fase 1)
- `security/authProtocol.ts` — Autenticação via primeiro frame WebSocket (evita vazar o token na URL).
- `security/pathValidator.ts` — Impede escrita fora do projeto, path traversal e escapes por symlink.
- `security/messageValidator.ts` — Valida o formato e os limites de tamanho de cada mensagem WS.
- `fileFingerprint.ts` — Detecta se um arquivo foi modificado no VS Code enquanto o modelo gerava a resposta.

### Full Code 2.0 (Fase 2)
- `agent/runManager.ts` — Orquestra uma execução contínua de um único agente, decidindo `continue`, `retry`, `done` ou `stop`.
- `agent/planManager.ts` — Persiste as missões e tarefas em `.deepseek-sync/agent/plans/`.
- `agent/iterationGuard.ts` — Evita loops infinitos (falhas seguidas, falta de progresso).
- `agent/recoveryManager.ts` — Salva o `current-run.json` para permitir retomada após fechar o VS Code.

### Inteligência (Fase 3)
- `intelligence/dependencyAnalyzer.ts` — Mapeia importações e dependências transitivas.
- `intelligence/semanticSearch.ts` — Busca por similaridade local, sem uso de API.
- `intelligence/contextBudget.ts` — Corta o contexto priorizando entry points, configs e hubs.
- `memory/projectMemory.ts` — Memória de longo prazo do projeto (erros, decisões, convenções) em `.deepseek-sync/memory/`.

### Multiagente (Fase 5)
- `multiagent/missionController.ts` — Diretor da missão. Distribui tarefas para Analista, Planejador, Dev, Tester, Revisor, Integrador e Auditor.
- `multiagent/rolePrompts.ts` — Instruções específicas para cada papel (prompt engineering).
- `multiagent/finalAuditor.ts` — Verifica se o objetivo foi cumprido antes de encerrar a missão.

## Módulos do Navegador (`browser-extension/`)

- `manifest.json` — Configuração da extensão. Carrega os scripts na ordem correta para cada site.
- `core/protocol.js` — Constantes e utilidades compartilhadas.
- `core/agentState.js` — Máquina de estados visual (IDLE, RUNNING, PAUSED, etc).
- `providers/` — Adaptadores para DeepSeek, Gemini e ChatGPT. Contêm os seletores CSS e a lógica de digitar/ler na página.
- `controllers/agentController.js` — O loop do agente que interage com a interface.
- `controllers/multiagentController.js` — Interface para as tarefas do multiagente.
- `ui/panel.js` — O painel flutuante que o usuário vê.
