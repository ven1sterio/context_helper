# Segurança e Confiabilidade

O sistema foi projetado para ser seguro por padrão, protegendo o projeto contra alucinações do modelo, caminhos maliciosos e falhas de aplicação.

## 1. Validação de Caminhos (`security/pathValidator.ts`)
- **Path Traversal**: Caminhos com `../` ou `..\` são rejeitados.
- **Absolutos**: `/etc/passwd` ou `C:\Windows` são bloqueados.
- **Symlinks**: A extensão resolve o caminho real do diretório pai e bloqueia se ele apontar para fora do workspace.
- **Bytes Nulos**: Strings contendo `\0` são rejeitadas imediatamente.

## 2. Autenticação (`security/authProtocol.ts`)
- O token do VS Code **nunca** é enviado na URL do WebSocket (o que ficaria salvo no histórico).
- O navegador envia o token no primeiro frame (`{ type: 'auth', token }`).
- O servidor rejeita qualquer comando antes da autenticação ou se o token estiver errado. A conexão é encerrada após 5 segundos sem autenticação.

## 3. Validação de Mensagens (`security/messageValidator.ts`)
- Todo payload recebido do navegador passa por checagem de tipo, campos obrigatórios e limites de tamanho (ex: arquivos não podem passar de 500 KB).
- Mensagens com tipo desconhecido ou formato inválido são silenciosamente rejeitadas com um erro logado no painel.

## 4. Transações e Rollback (`applyTransaction.ts`)
- A aplicação de um lote de arquivos é tratada como transação.
- Se a escrita do 3º arquivo falhar, os 2 anteriores são restaurados (rollback) e o sistema informa o erro.
- Backups completos são salvos em `.deepseek-sync/backup/` antes de qualquer alteração.

## 5. Arquivos Sensíveis (`pathRules.ts`)
- Por padrão (`.env`, `*.key`, `*.pem`), arquivos sensíveis são omitidos do contexto e não podem ser escritos pelo modelo.
- A configuração `deepseekContextSync.allowSensitiveFiles` pode ser ativada para permitir (não recomendado).
- `.env.local` é uma exceção: o modelo pode gerá-lo, mas o conteúdo existente nunca é enviado para o contexto.

## 6. Detecção de Conflitos (`fileFingerprint.ts`)
- Ao enviar o contexto, o sistema guarda um hash SHA-1 dos arquivos enviados.
- Se o usuário alterar o arquivo no VS Code enquanto o modelo pensa, ao tentar aplicar a edição o sistema detecta a mudança e bloqueia a sobrescrita, avisando o usuário.
