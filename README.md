# DeepSeek Context Sync

Conecta o VS Code ao chat web do **DeepSeek** ou do **Gemini**: envia o contexto do
projeto (completo, só as alterações ou seletivo), recebe de volta `### FILE:` /
`EDIT:` e aplica no projeto — no modo **manual** (com confirmação) ou em loop
autônomo (**Full Code**).

Tudo funciona pela **página** do chat. Não há chamadas de API (a integração com a
API do Gemini foi removida: não respondia em arquivos grandes e repetia requisições).

## Modos de operação

- **Manual:** você anexa o contexto, conversa com o modelo e clica em **📥 Aplicar** para
  revisar e confirmar cada alteração no VS Code.
- **Full Code (agente autônomo):** o ciclo enviar → receber → aplicar → executar → corrigir
  roda sozinho até o projeto funcionar ou o limite de iterações ser atingido.

## Estrutura

```
deepseek-context-sync/
├── browser-extension/            # Extensão do navegador (Chrome/Edge)
│   ├── manifest.json             # content scripts separados por site (DeepSeek e Gemini)
│   ├── providers/deepseek.js     # seletores/envio/leitura do chat.deepseek.com
│   ├── providers/gemini.js       # seletores/envio/leitura do gemini.google.com
│   ├── prompt.js                 # monta os prompts (regras, contexto completo, deltas, Full Code)
│   ├── parser.js                 # lê a resposta e extrai FILE: / EDIT: (SEARCH/REPLACE)
│   ├── content.js                # painel, conexão com o VS Code e loop do agente
│   └── background.js             # ponte WebSocket com o VS Code
└── vscode-extension/             # Extensão do VS Code (servidor WebSocket local, porta 8765)
    ├── src/
    │   ├── extension.ts          # ativação, token e ligação dos módulos
    │   ├── wsServer.ts           # comunicação com o navegador (origens permitidas + token)
    │   ├── contextManager.ts     # varre o projeto; monta tree, contexto completo e deltas
    │   ├── indexer.ts            # índice local (.deepseek-sync/index.json): símbolos, imports, tokens
    │   ├── selector.ts           # modo seletivo: ranqueia arquivos e monta o contexto com esqueletos
    │   ├── graphStore.ts         # lê o graphify-out/graph.json
    │   ├── graphSelector.ts      # seleção guiada pelo grafo (apoio ao seletivo)
    │   ├── pathRules.ts          # pastas excluídas, tipos de arquivo, binários, arquivos sensíveis
    │   ├── applyPlan.ts          # valida e resolve FILE/EDIT em arquivos finais (testável, sem VS Code)
    │   ├── applyManager.ts       # aplica com confirmação (diff opcional) ou automático; backups
    │   ├── taskRunner.ts         # executa build/testes (terminal integrado ou segundo plano)
    │   ├── stateManager.ts       # .deepseek-sync/state.md (objetivo, plano, o que funciona/quebrou)
    │   └── timeouts.ts           # timeouts de resposta, execução e aplicação
    └── test/                     # npm test: parser, applyPlan e seleção por grafo
```

`summarizer.ts`, `geminiClient.ts` e `quota.ts` são restos da integração com a API do
Gemini e ficam fora da compilação (`tsconfig.json`).

## Instalar

1. VS Code: `cd vscode-extension && npm install && npm run compile`, depois rodar a
   extensão (F5) ou empacotar.
2. Navegador: `chrome://extensions` → modo desenvolvedor → "Carregar sem compactação" →
   pasta `browser-extension`. Se já estava carregada, clique em **recarregar**.
3. VS Code: `Ctrl+Shift+P` → "DeepSeek Context Sync: Copiar Token" (ou "Mostrar Token").
   No chat (DeepSeek ou Gemini), abra o painel e clique em **🔑 Token** para colar.

## Painel do chat

| Botão | O que faz |
|---|---|
| 🔄 Contexto | Envia o contexto completo (use no início de uma conversa nova) |
| 📎 Anexar contexto / alterações | Envia o contexto ou só o que mudou desde o último envio |
| 🎯 Seletivo | Escolhe só os arquivos relevantes ao seu pedido (veja abaixo) |
| 📋 Revisar | No seletivo, mostra a lista de arquivos para ajustar antes de colar |
| 📥 Aplicar | Lê a última resposta e aplica no VS Code (com confirmação) |
| 🔁 Full Code | Liga o agente autônomo; **🚀 Rodar agente** inicia, **⏹ Parar** encerra |
| ⚡ Instantâneo | Remove as esperas anti-spam entre envios (desligue se o site limitar) |
| ⏱ Esperar mais | Estende o tempo de espera por uma resposta longa |
| 🆕 Nova conversa | Abre outra conversa e cola o estado salvo (`state.md`) |
| 🔑 Token | Cola o token do VS Code |

## Formato das respostas

O prompt instrui o modelo a responder com um destes formatos:

**A — arquivo completo** (obrigatório para arquivos novos e mudanças grandes):

````
### FILE: caminho/do/arquivo.ext
```linguagem
<conteúdo COMPLETO>
```
````

**B — edição por trechos** (arquivos grandes, mudança localizada). O bloco vai **sempre
dentro de uma cerca de código**; vários blocos no mesmo `EDIT:` são aplicados em ordem:

````
EDIT: caminho/do/arquivo.ext
```text
<<<<<<< SEARCH
trecho exato que já existe
=======
novo trecho
>>>>>>> REPLACE
```
````

Regras: o mesmo arquivo não pode aparecer como `FILE:` e `EDIT:` na mesma resposta; nada
de `...` nem "resto do código"; caminhos só da estrutura enviada.

### Como a aplicação funciona

- **Parser tolerante:** aceita `REPLACE` solto no fechamento (sem `>>>>>>>`), blocos sem
  cercas de código e vários `EDIT:` dentro de um único bloco. Bloco malformado vira erro
  explícito, nunca é descartado em silêncio. `EDIT:` seguido de código sem
  SEARCH/REPLACE **não** sobrescreve o arquivo: vira erro (use `### FILE:`).
- **Vários `EDIT:` no mesmo arquivo** são todos mantidos, em ordem.
- **Correspondência do SEARCH:** primeiro exata (precisa casar 1 vez). Se não achar, tenta
  de forma tolerante a espaços, indentação e crases perdidas em template strings: só o
  trecho que muda é substituído, preservando o original. Se casar mais de uma vez, é recusado.
- **Edição fora de cerca de código** (o chat a renderiza como texto e apaga a indentação):
  é recuperada, reindentada por heurística e avisada no diálogo. **No Full Code é recusada**
  e o modelo é mandado reenviar dentro de uma cerca.
- **`deepseekContextSync.applyMode`:** `partial` (padrão) aplica as edições que casam e lista
  as que não casaram, pedindo confirmação; `atomic` rejeita tudo se uma falhar. O Full Code
  sempre usa `atomic`.
- Erro "SEARCH não aparece" mostra a linha mais parecida; edição já aplicada vira aviso.
- CRLF do arquivo original é preservado. Arquivos que encolhem muito, sensíveis ou com
  alterações não salvas ganham aviso no diálogo.
- **Backup** antes de cada aplicação em `.deepseek-sync/backup/<data>/` (mantém os 10 mais
  recentes). Você também pode usar "Revisar diff primeiro".

## Contexto enviado ao chat

- **Limites padrão:** `maxFileKB = 300` (por arquivo) e `maxTotalKB = 800` (por envio). O que
  exceder o total é omitido (contexto completo) ou fica para o próximo clique (alterações); a
  lista dos omitidos aparece no próprio contexto.
- **Detecção de binários:** a extensão lê os primeiros 8 KB e descarta o que parece binário
  (byte nulo ou mais de 30% de controles). Imagens, PDFs e executáveis ficam de fora; SVG,
  `.env`, `.lock` e arquivos sem extensão conhecida entram normalmente.
- **Tree completa:** todos os arquivos visíveis aparecem na tree (até 20.000 arquivos
  varridos e 2.000 linhas), mesmo os que não têm o conteúdo enviado.
- **Pastas ignoradas** (fora do contexto, da tree, do watcher e **sem escrita** pelo chat):
  `node_modules`, `.git`, `dist`, `out`, `build`, `.next`, `.nuxt`, `.vscode`, `.idea`,
  `__pycache__`, `.venv`, `venv`, `coverage`, `target`, caches de frameworks (`.turbo`,
  `.vercel`, `.cache`, `.parcel-cache`, `.swc`, `.svelte-kit`, `.angular`, `.docusaurus`,
  `.expo`, `.gradle`, `.mvn`, `.yarn`, `bower_components`, `tmp`, `temp`), pastas de
  ferramentas de IA (`.agents`, `.claude`, `.windsurf`, `.cursor`, `.continue`, `.aider`) e
  `.deepseek-sync`.
- **Gemini:** acima de 40 mil caracteres o contexto vai como anexo `contexto-projeto.txt`
  (o campo de texto leva só as regras, a tree, uma nota e a sua pergunta). Se o anexo falhar,
  o texto é colado em partes.

### Modo seletivo (🎯)

Em vez de mandar tudo, escolhe os arquivos relevantes ao seu pedido. O chat recebe as
regras de resposta, a **tree completa**, os **arquivos escolhidos** e a pergunta.

- **Escolha local:** quebra o pedido em termos, expande sinônimos/conceitos (ex.: "tela" →
  `pages`, `components`, `layout`) e pontua por nome, símbolo, export, pasta, tag, resumo e
  ocorrências no conteúdo. Segue os imports até 2 níveis e inclui quem importa os principais.
- **Grafo (apoio):** com `graphify-out/graph.json` e `useGraph = auto`, nós cujo rótulo casa
  com o pedido viram sementes e a busca expande 2 saltos. O grafo só decide **quais** arquivos
  entram; o código vem do VS Code.
- **Pedido vago:** completa com visão geral (README, configs, arquivos de entrada, mais importados).
- **Orçamento:** `maxContextTokens` (120000). 90% para arquivos completos; o que não cabe vira
  **esqueleto** (só assinaturas e tamanho). O cabeçalho manda o modelo pedir os caminhos que
  faltarem em vez de supor o conteúdo.
- Com **📋 Revisar** ligado, a lista (com o motivo de cada arquivo) aparece antes de colar.

## Full Code (um único prompt)

Ative **🔁 Full Code**, escreva o pedido (ex.: "crie uma API de tarefas em Node com testes") e
clique em **🚀 Rodar agente**. O modelo faz um plano em etapas e, a cada resposta, implementa
uma etapa. O agente aplica os arquivos, instala dependências, executa o build/testes e
devolve o resultado; se falhar, ele corrige, se passar, pede a próxima etapa.

- Cada resposta termina com `[[STATUS:CONTINUAR]]` ou `[[STATUS:CONCLUIDO]]` e depois
  `[[FIM-DA-RESPOSTA]]`.
- Termina quando o modelo responde `CONCLUIDO`, quando não envia arquivos, ou após **40
  iterações** (`MAX_AGENT_ITERATIONS` em `content.js`). Após 20 o chat pode ficar lento: use
  **🆕 Nova conversa**.
- **Respostas cortadas:** quando o site mostra **Continuar**, o agente clica sozinho. Se o
  modelo pedir confirmação em texto, o agente responde "continue" sozinho.
- Recomendado: em uma conversa NOVA, clique antes em **🔄 Contexto**.

### Execução (build/testes) no terminal integrado

Após aplicar os arquivos, o agente executa o build no terminal integrado do VS Code (aba
**DeepSeek Agent**), onde você acompanha ao vivo. A saída e o código de saída voltam ao chat
quando algo falha.

- **Detecção automática:** `npm install` (se faltar/estiver desatualizado) + `npm run build`
  / `check` / `test` (na raiz ou em subpastas diretas com `package.json`); `cargo check`;
  `go build ./...`; Python com `pytest` ou `compileall`.
- Para fixar outro comando: `runCommand` (use `&&` para encadear; cada passo roda separado).
- `runInTerminal = false` força processo em segundo plano (saída em Saída → DeepSeek Agent).
  Há fallback automático se o terminal não tiver shell integration (ex.: cmd.exe) ou se o
  PowerShell bloquear scripts.

## Arquivos sensíveis (.env, chaves)

Por padrão (`allowSensitiveFiles = false`) `.env`, `.env.*`, `*.pem`, `*.key`, credenciais etc.
são **bloqueados**: não entram no contexto e não podem ser escritos pelo chat. Exceção: o chat
pode criar/alterar `.env.local` (o conteúdo atual dele **nunca** é enviado; confira o diff).
Ligue a opção (e recarregue a janela do VS Code) para liberar contexto e escrita. Templates
(`.env.example`, `.env.sample`, `.env.template`, `.env.dist`) nunca são tratados como sensíveis.
Chaves e tokens que apareçam em mensagens de erro do servidor são mascarados.

## Configurações

| Configuração (`deepseekContextSync.`) | Padrão | Descrição |
|---|---|---|
| `maxFileKB` | 300 | Tamanho máximo (KB) de cada arquivo |
| `maxTotalKB` | 800 | Tamanho máximo (KB) de cada envio ao chat |
| `maxContextTokens` | 120000 | Orçamento de tokens do contexto seletivo |
| `applyMode` | `partial` | `partial` aplica o que casa e lista o resto; `atomic` rejeita tudo se algo falhar (Full Code é sempre `atomic`) |
| `runCommand` | vazio | Comando do Full Code (vazio = auto-detectar) |
| `runInTerminal` | `true` | Executa no terminal integrado do VS Code |
| `responseTimeout` | 600 | Espera pela resposta do chat (60, 300 ou 600 s) |
| `runTimeout` | 600 | Tempo de um comando de build/teste (60, 300 ou 600 s) |
| `runTimeoutSec` | 600 | Compat: usado se definido e `runTimeout` não estiver |
| `allowSensitiveFiles` | `false` | Libera `.env`, chaves e credenciais |
| `useGraph` | `auto` | `auto` usa o `graph.json` se existir; `off` ignora |
| `graphPath` | `graphify-out/graph.json` | Caminho do grafo (relativo ao workspace) |

## Arquivos locais da extensão

Ficam em `.deepseek-sync/` (já no `.gitignore`): `index.json` (índice), `state.md` (estado do
trabalho, colado ao abrir **🆕 Nova conversa**; as seções `decisions` e `rollbacks` são suas e o
código não as sobrescreve) e `backup/` (cópias antes de cada aplicação).

## Adicionar outro site

Crie `providers/<site>.js` implementando a interface descrita no topo de
`providers/deepseek.js` (expondo `window.DSProvider` e `window.DSProviderName`), adicione o
host em `host_permissions` e um bloco em `content_scripts` do `manifest.json`, e inclua a
origem em `ALLOWED_ORIGINS` (`vscode-extension/src/wsServer.ts`).

## Se o site mudar o HTML

Os seletores ficam no topo de cada provider (`ASSISTANT_SELECTORS`, `INPUT_SELECTORS`,
`SEND_SELECTORS`, `STOP_SELECTORS`). No Gemini (Angular) prefira nomes de elemento
(`model-response`, `message-content`, `rich-textarea`) e `aria-label` a classes
`_ngcontent-*`, que mudam a cada build.

## Testes

```
cd vscode-extension
npm test        # compila e roda parser, applyPlan e o smoke do grafo
```

## Histórico

- **0.6.1:** edições `EDIT:` fora de cerca de código passam a ser recuperadas (reindentadas e
  avisadas; recusadas no Full Code); o prompt exige SEARCH/REPLACE dentro de cerca; `EDIT:` sem
  blocos não sobrescreve mais o arquivo.
- **0.6.0:** vários `EDIT:` no mesmo arquivo (antes só o último sobrevivia); parser tolerante;
  correspondência tolerante do SEARCH; `applyMode`; dica da linha mais parecida; testes.

## Script: limpar skills duplicadas e aumentar o limite de contexto

As pastas `.agents`, `.claude` e `.windsurf` já são ignoradas pela extensão; este script é
útil só para tirá-las do projeto (liberar espaço/duplicatas) e subir `maxTotalKB`. Salve como
`limpar-contexto.ps1` e rode na raiz do projeto que você sincroniza. Ele move as pastas para um
backup fora do projeto e atualiza `deepseekContextSync.maxTotalKB` no `settings.json` do VS Code.

```powershell
param(
    [string]$ProjectRoot = (Get-Location).Path,
    [ValidateSet(".agents", ".claude", ".windsurf", "all")]
    [string]$Remove = "all",
    [int]$MaxTotalKB = 1500
)

$ErrorActionPreference = "Stop"
Write-Host "Projeto: $ProjectRoot" -ForegroundColor Cyan

# --- 1) Move skills duplicadas para FORA do projeto ---
$backupDir = Join-Path (Split-Path $ProjectRoot -Parent) ("backup_skills" + (Get-Date -Format "yyyyMMdd-HHmmss"))
$toMove = if ($Remove -eq "all") { @(".agents", ".claude", ".windsurf") } else { @($Remove) }

New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$moved = 0
foreach ($d in $toMove) {
    $src = Join-Path $ProjectRoot $d
    if (Test-Path $src) {
        $sizeKB = [math]::Round((Get-ChildItem $src -Recurse -File |
                                 Measure-Object Length -Sum).Sum / 1KB, 1)
        Move-Item -Path $src -Destination (Join-Path $backupDir $d)
        Write-Host "Movido: $d ($sizeKB KB liberados)" -ForegroundColor Yellow
        $moved++
    } else {
        Write-Host "Ignorado (não existe): $d"
    }
}

if ($moved -eq 0) {
    Write-Host "Nada para mover." -ForegroundColor Yellow
} else {
    Write-Host "Backup em: $backupDir" -ForegroundColor Green
}

# --- 2) Atualiza settings.json do VS Code ---
$settingsPaths = @(
    (Join-Path $env:APPDATA "Code\User\settings.json"),
    (Join-Path $env:APPDATA "Code - Insiders\User\settings.json")
) | Where-Object { Test-Path $_ }

if ($settingsPaths.Count -eq 0) {
    Write-Warning "settings.json do VS Code nao encontrado. Edite manualmente:"
    Write-Host "  ""deepseekContextSync.maxTotalKB"": $MaxTotalKB"
    exit
}

foreach ($sp in $settingsPaths) {
    $bak = "$sp.bak-" + (Get-Date -Format "yyyyMMdd-HHmmss")
    Copy-Item $sp $bak

    $text = [System.IO.File]::ReadAllText($sp)
    $pattern = '("deepseekContextSync\.maxTotalKB"\s*:\s*)\d+'

    if ($text -match $pattern) {
        # Chave ja existe -> substitui valor
        $text = $text -replace $pattern, ('${1}' + $MaxTotalKB)
    } else {
        # Chave ausente -> insere antes do ultimo }
        $idx = $text.LastIndexOf('}')
        if ($idx -ge 0) {
            $before = $text.Substring(0, $idx).TrimEnd()
            $after  = $text.Substring($idx)

            $needsComma = -not ($before.EndsWith('{') -or $before.EndsWith(','))
            $comma = if ($needsComma) { ',' } else { '' }

            $insert = @"
$comma
    "deepseekContextSync.maxTotalKB": $MaxTotalKB
"@
            $text = $before + $insert + $after
        }
    }

    [System.IO.File]::WriteAllText($sp, $text, [System.Text.UTF8Encoding]::new($false))
    Write-Host "Atualizado: $sp (backup: $bak)" -ForegroundColor Green
}

Write-Host ""
Write-Host "Pronto. Recarregue a aba do chat (F5) e clique em 'Contexto completo'." -ForegroundColor Cyan
```
