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
