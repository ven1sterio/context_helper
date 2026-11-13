# DeepSeek Context Sync 2.0

Conecta o VS Code ao chat web do **DeepSeek**, **Gemini** ou **ChatGPT** para atuar como um agente autônomo de desenvolvimento. O sistema envia o contexto do projeto, recebe de volta arquivos e edições, aplica no código, executa testes e corrige a si mesmo.

Funciona 100% através da **interface web** dos chats (sem APIs pagas). A versão 2.0 introduz inteligência de contexto, transações seguras, agente autônomo persistente e uma arquitetura multiagente.

## Recursos Principais
- **Agente Autônomo (Full Code)**: Cria um plano, implementa, roda build/testes e corrige os próprios erros.
- **Multiagente**: Divide uma missão entre Analista, Planejador, Desenvolvedor, Testador, Revisor, Integrador e Auditor.
- **Inteligência de Contexto**: Busca semântica local, análise de dependências e orçamento de tokens (envia só o que importa).
- **Segurança Transacional**: Path traversal protection, autenticação WS, rollback de arquivos e detecção de conflitos.

## Como Instalar

### 1. VS Code (Extensão)
```bash
cd vscode-extension
npm install
npm run compile

## Engenharia reversa de DLL/EXE (`### RE:`)

A IA do chat pode **olhar dentro** de binários do workspace e alterá-los, pedindo com uma linha por operação:

```
### RE: info Qt6OpenGL.dll
### RE: functions Qt6OpenGL.dll filter=Shader limit=50
### RE: decompile Qt6OpenGL.dll NomeDaFuncao        (ou 0x endereço)
### RE: disasm Qt6OpenGL.dll 0x180001000 count=40
### RE: xrefs Qt6OpenGL.dll NomeDaFuncao
### RE: strings Qt6OpenGL.dll "Program binary received"
### RE: asm Qt6OpenGL.dll addr=0x180001000 text="nop"
### RE: patch Qt6OpenGL.dll rva=0x1A2B expect="48 89 5C 24 08" write="90 90 90 90 90"
```

O resultado volta ao chat automaticamente no modo agente; no modo manual, o botão **📥 Aplicar** executa os pedidos e cola o resultado no campo de entrada.

| Tipo de binário | Como é analisado |
|---|---|
| Nativo (C/C++) | Ghidra headless (análise uma vez, cache na pasta de armazenamento global da extensão (sem segmento iniciado por ponto: o Ghidra recusa esses caminhos)) |
| .NET | ILSpy (`ilspycmd`): `decompile` por tipo → C#, `disasm` por tipo → IL |
| Qualquer PE | `patch` de bytes de mesmo tamanho |

**Configuração**
- Nativo: instale o Ghidra e o JDK exigido pela versão escolhida; configure `deepseekContextSync.ghidraPath` (ou `GHIDRA_HOME`).
- .NET: `dotnet tool install --global ilspycmd`.
- `deepseekContextSync.reEnabled` liga/desliga o recurso.

**Segurança**
- Só abre `.dll .exe .sys .ocx .node .so .dylib` dentro do workspace.
- `patch` confere os bytes originais (`expect`), exige mesmo tamanho, **pede sua aprovação** e grava uma cópia `nome.patched.dll`. `inplace=true` grava no original com backup `.orig`.
- A mensagem `reRequest` passa pelo mesmo validador e pela mesma autenticação por token das demais.

**Diagnóstico do Ghidra**: o launcher é executado com tratamento específico para Windows e Unix. A extensão verifica o código de saída, a existência do arquivo de resultado, a saída vazia e os marcadores de erro do `ReBridge.java`. O projeto só é marcado como analisado quando todas essas verificações passam. Os testes simulam o launcher; eles não substituem a validação com uma instalação real do Ghidra.

**Limites**: o pseudo-C do Ghidra é aproximado (sem `.pdb`, funções internas aparecem como `FUN_xxxx`); patch não insere código novo nem recompila; DLL empacotada/protegida precisa ser desempacotada antes.
