# Recuperação e Diagnóstico

Como o sistema é autônomo, ele pode falhar (queda de rede, fechamento do VS Code, erro de build persistente). Estes são os mecanismos de recuperação.

## 1. Retomada de Execução (`RecoveryManager`)
- Enquanto o agente Full Code roda, o estado da missão e as iterações são salvos em `.deepseek-sync/agent/current-run.json`.
- Se você fechar o VS Code no meio de uma execução, ao reabrir, a extensão lerá esse arquivo.
- Um pop-up aparecerá: *"Há uma execução interrompida. Retomar?"*
- Se você aceitar, o agente volta de onde parou.
- Se o arquivo original não existir mais no disco (por exemplo, você o apagou manualmente), o sistema marca a execução como "stale" e não retoma, para evitar erros.

## 2. Histórico (`RunHistory`)
- Toda execução concluída (ou com falha definitiva) é arquivada em `.deepseek-sync/agent/history/run-<id>.json`.
- O sistema mantém as 50 execuções mais recentes.

## 3. Loop Infinito (`IterationGuard`)
- O agente nunca rodará para sempre. O guard bloqueia a execução se:
  - Ocorrerem 6 falhas consecutivas de build/aplicação.
  - Ocorrerem 3 iterações sem que nenhum arquivo seja gerado.
  - O agente tentar usar a mesma solução 3 vezes e falhar.
  - Atingir o limite absoluto de 40 iterações.

## 4. Diagnóstico (`deepseekContextSync.diagnose`)
- No VS Code, abra a Paleta de Comandos (`Ctrl+Shift+P`) e rode **"DeepSeek Context Sync: Diagnóstico"**.
- Um relatório markdown será aberto mostrando o status de cada módulo, a existência de pastas (`.deepseek-sync`), o tamanho do índice e dicas para falhas comuns.
