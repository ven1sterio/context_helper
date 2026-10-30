# DeepSeek Context Sync

Extensão que conecta o VS Code ao chat web do **DeepSeek** ou do **Gemini**: envia
contexto (completo ou seletivo), recebe `FILE:` / `EDIT:` e aplica de volta no
projeto — no modo manual (com confirmação) ou em loop autônomo (Full Code).

Tudo funciona pela **página** do chat. Não há chamadas de API (a integração com a
API do Gemini foi removida: não respondia em arquivos grandes e repetia requisições).

## Estrutura

    browser-extension/
      manifest.json          # content scripts separados por site
      providers/deepseek.js  # seletores/envio/leitura do chat.deepseek.com
      providers/gemini.js    # seletores/envio/leitura do gemini.google.com
      prompt.js, parser.js, content.js   # lógica comum (usa window.DSProvider)
      background.js          # ponte WebSocket com o VS Code
    vscode-extension/src/    # servidor WS, índice local, seleção, aplicação de arquivos

## Instalar

1. VS Code: `cd vscode-extension && npm install && npm run compile`, depois rodar a extensão (F5) ou empacotar.
2. Navegador: `chrome://extensions` → modo desenvolvedor → "Carregar sem compactação" → pasta `browser-extension`.
   Se já estava carregada, clique em **recarregar** (o manifest mudou: agora inclui `gemini.google.com`).
3. VS Code: `Ctrl+Shift+P` → "DeepSeek Context Sync: Copiar Token". No chat (DeepSeek ou Gemini), abra o painel e use "🔑 Token".

## Adicionar outro site

Crie `providers/<site>.js` implementando a interface descrita no topo de
`providers/deepseek.js` (expondo `window.DSProvider` e `window.DSProviderName`),
adicione o host em `host_permissions` e um bloco em `content_scripts`, e inclua a
origem em `ALLOWED_ORIGINS` (`vscode-extension/src/wsServer.ts`).

## Se o Gemini mudar o HTML

Os seletores ficam no topo de `providers/gemini.js`: `ASSISTANT_SELECTORS` (resposta),
`INPUT_SELECTORS` (campo), `SEND_SELECTORS` e `STOP_SELECTORS` (botões). O Gemini
usa Angular, então prefira nomes de elemento (`model-response`, `message-content`,
`rich-textarea`) e `aria-label` a classes `_ngcontent-*`, que mudam a cada build.
