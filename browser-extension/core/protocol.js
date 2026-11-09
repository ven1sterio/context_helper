// Constantes e utilitários compartilhados. Todos os módulos leem daqui.
// Carregado primeiro — não pode ter dependência de outros módulos.
(function () {
    'use strict';
    window.DS = window.DS || {};

    const WS_URL = 'ws://127.0.0.1:8765';

    const MAX_AGENT_ITERATIONS = 40;
    const MAX_CONSECUTIVE_FAILURES = 6;
    const SUGGEST_NEW_CHAT_AFTER = 20;

    const HUMAN_DELAY = {
        warmup: [1500, 3500],
        beforeSend: [2000, 5000],
        afterSend: [600, 1500],
        betweenContinue: [2500, 5000],
        afterFailure: [8000, 15000],
        afterSendFailed: [20000, 40000],
        betweenResends: [55000, 65000],
        maxContinueClicks: 5
    };

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    window.DS.protocol = {
        WS_URL,
        MAX_AGENT_ITERATIONS,
        MAX_CONSECUTIVE_FAILURES,
        SUGGEST_NEW_CHAT_AFTER,
        HUMAN_DELAY,
        sleep
    };
})();
