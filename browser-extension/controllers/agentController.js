// Ciclo do agente Full Code. Não conhece DOM nem provider — só chama
// window.DS.getProvider() e window.DS.connection.
(function () {
    'use strict';
    window.DS = window.DS || {};
    const {
        sleep, HUMAN_DELAY, MAX_AGENT_ITERATIONS,
        MAX_CONSECUTIVE_FAILURES, SUGGEST_NEW_CHAT_AFTER
    } = window.DS.protocol;
    const { STATES } = window.DS;
    const conn = window.DS.connection;
    const state = window.DS.agentState;
    const ctx = window.DS.context;

    let agentRunning = false;
    let agentSuggestedNewChat = false;
    let waitResolve = null;
    let agentTouched = new Set();
    let currentMissionId = null;
    let currentRunId = null;
    let instantMode = false;

    function humanDelay(range) {
        if (instantMode) return sleep(range === HUMAN_DELAY.afterSendFailed ? 5000 : 150);
        const [min, max] = range;
        return sleep(Math.round(min + Math.random() * (max - min)));
    }

    async function waitBetweenResends() {
        if (instantMode) return;
        const [min, max] = HUMAN_DELAY.betweenResends;
        const totalMs = Math.round(min + Math.random() * (max - min));
        const endAt = Date.now() + totalMs;
        while (agentRunning && Date.now() < endAt) {
            const remaining = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
            window.DS.panel.toast(`⏸️ Aguardando ${remaining}s antes do próximo envio (anti-spam)...`);
            const chunk = Math.min(5000, Math.max(250, endAt - Date.now()));
            await sleep(chunk);
        }
    }

    function showWaitMoreButton() {
        return new Promise((resolve) => {
            waitResolve = resolve;
            state.transition(STATES.PAUSED);
            window.DS.panel.toast('⏱️ Timeout: clique em "Esperar mais" ou "Parar".');
        });
    }

    function resolveWaitMore(cont) {
        if (!waitResolve) return;
        const r = waitResolve;
        waitResolve = null;
        state.transition(STATES.RUNNING);
        r(cont);
    }

    async function waitForResponseComplete(timeoutMs, baseline, askExtend) {
        const p = window.DS.getProvider();
        const initialCount = baseline.count;
        const initialLast = baseline.last;

        // Espera aparecer
        const start = Date.now();
        let appeared = false;
        while (Date.now() - start < 120000) {
            if (!agentRunning) return false;
            await sleep(200);
            const now = p.snapshotAssistant();
            if (now.count > initialCount || (now.last && now.last !== initialLast)) { appeared = true; break; }
        }
        if (!appeared) return false;

        while (true) {
            const phaseStart = Date.now();
            let lastText = '';
            let stableSince = Date.now();
            let continueClicks = 0;
            while (Date.now() - phaseStart < timeoutMs) {
                if (!agentRunning) return false;
                const text = p.messageText(p.findLastAssistantMessage());
                if (text !== lastText) { lastText = text; stableSince = Date.now(); }
                const stableFor = Date.now() - stableSince;
                const ended = p.hasEndMarker(text);
                const status = p.readStatus(text);
                if (ended && stableFor > 1200) return true;
                if (!ended && stableFor > 1500 && continueClicks < HUMAN_DELAY.maxContinueClicks) {
                    const btn = p.findContinueButton();
                    if (btn) {
                        continueClicks++;
                        window.DS.panel.toast(`⏩ Resposta cortada: clicando em "Continuar" (${continueClicks}/${HUMAN_DELAY.maxContinueClicks})...`);
                        btn.click();
                        stableSince = Date.now();
                        await humanDelay(HUMAN_DELAY.betweenContinue);
                        continue;
                    }
                }
                const needed = status === 'done' ? 2500 : 8000;
                if (stableFor > needed && lastText.trim().length > 10 && !p.findStopButton()) return true;
                await sleep(300);
            }
            if (!askExtend) return false;
            const more = await askExtend();
            if (!more) return false;
        }
    }

    async function stop() {
        agentRunning = false;
        resolveWaitMore(false);
        conn.abort();
        if (currentRunId) conn.cancelRun('usuário parou o agente');
        currentMissionId = null;
        currentRunId = null;
        state.transition(STATES.IDLE);
        window.DS.panel.toast('⏹ Agente parado.');
    }

    async function start() {
        if (!conn.isOpen()) {
            window.DS.panel.toast(conn.authToken ? 'Sem conexão com o VS Code.' : '🔑 Token não configurado.');
            return;
        }
        if (agentRunning) { window.DS.panel.toast('Agente já está rodando.'); return; }

        const p = window.DS.getProvider();
        const input = p.findInput();
        if (!input) { window.DS.panel.toast('Campo de entrada não encontrado.'); return; }
        const current = p.readInput(input);
        if (current.includes(PROMPT_MARKER)) {
            window.DS.panel.toast('O campo já contém contexto. Limpe e escreva sua pergunta.');
            return;
        }
        const question = current.trim();
        if (!question) { window.DS.panel.toast('Digite a pergunta antes de rodar o agente.'); return; }

        agentRunning = true;
        agentSuggestedNewChat = false;
        agentTouched = new Set();
        currentMissionId = null;
        currentRunId = null;
        state.transition(STATES.STARTING, { iteration: 0 });

        try {
            const started = await conn.startMission(question.slice(0, 200), question);
            if (started && started.missionId && started.runId) {
                currentMissionId = started.missionId;
                currentRunId = started.runId;
                state.transition(STATES.STARTING, {
                    missionId: started.missionId,
                    runId: started.runId
                });
            }
        } catch { /* segue sem mission */ }

        conn.updateState({ objective: question.slice(0, 1500), plan: [], working: [], broken: [], lastFailure: '' });
        state.transition(STATES.RUNNING);

        try { await agentLoop(question); }
        catch (e) {
            window.DS.panel.toast('Erro no agente: ' + (e instanceof Error ? e.message : String(e)));
            state.transition(STATES.ERROR, { lastError: e instanceof Error ? e.message : String(e) });
        }
        finally {
            agentRunning = false;
            if (state.state !== STATES.ERROR) state.transition(STATES.IDLE);
            currentMissionId = null;
            currentRunId = null;
        }
    }

    async function agentLoop(initialQuestion) {
        const p = window.DS.getProvider();
        let promptText = initialQuestion;
        let needContext = true;
        let failures = 0;
        let stages = 0;
        let isFirstIteration = true;

        await humanDelay(HUMAN_DELAY.warmup);

        while (agentRunning && state.iteration < MAX_AGENT_ITERATIONS) {
            if (!agentRunning) return;
            if (!isFirstIteration) {
                await waitBetweenResends();
                if (!agentRunning) return;
            }
            isFirstIteration = false;

            state.transition(STATES.RUNNING, { iteration: state.iteration + 1 });
            window.DS.panel.toast(`⏳ Iteração ${state.iteration}/${MAX_AGENT_ITERATIONS}...`);

            if (state.iteration === SUGGEST_NEW_CHAT_AFTER && !agentSuggestedNewChat) {
                agentSuggestedNewChat = true;
                window.DS.panel.toast('💡 Sugestão: após 20 iterações o chat pode ficar lento.');
            }

            let textToSend = promptText;
            let composed = null;
            if (needContext) {
                const msg = await conn.requestContext('auto');
                if (!msg) { window.DS.panel.toast('VS Code não respondeu ao contexto.'); return; }
                if (msg.mode === 'empty') {
                    textToSend = buildDeltaPrompt({ tree: undefined, changes: '', question: promptText, fullCode: true });
                } else if (msg.mode === 'full') {
                    composed = ctx.composePrompt('full', { tree: msg.tree, data: msg.data, question: promptText, fullCode: true });
                    conn.nextIsDelta = true;
                } else {
                    composed = ctx.composePrompt('delta', { tree: msg.tree, data: msg.data, question: promptText, fullCode: true });
                }
                needContext = false;
            }

            const input = p.findInput();
            if (!input) { window.DS.panel.toast('Campo de entrada perdido.'); return; }
            await humanDelay(HUMAN_DELAY.beforeSend);

            const baseline = p.snapshotAssistant();
            let attached = false;
            if (composed) attached = (await ctx.deliverPrompt(input, composed)).attached;
            else await ctx.setInputBig(input, textToSend);
            await sleep(150);

            const sent = await p.pressSend(attached ? 60000 : 6000);
            if (!sent) {
                window.DS.panel.toast('⚠️ Envio falhou (possível limite de requisições).');
                await humanDelay(HUMAN_DELAY.afterSendFailed);
                conn.updateState({ lastFailure: 'Envio falhou — possível limite.' });
                return;
            }

            await humanDelay(HUMAN_DELAY.afterSend);
            window.DS.panel.toast(`💬 Iteração ${state.iteration}: aguardando o ${window.DS.siteName()}...`);
            const ok = await waitForResponseComplete(conn.timeouts.response * 1000, baseline, showWaitMoreButton);
            if (!ok) {
                if (!agentRunning) return;
                window.DS.panel.toast('Timeout: não detectei o fim da resposta.');
                return;
            }
            await sleep(800);

            const answerNode = p.findLastAssistantMessage();
            if (!answerNode) { window.DS.panel.toast('Não encontrei a resposta na página.'); return; }
            const status = p.readStatus(p.messageText(answerNode));
            const parsed = parseLastResponse();

            // Engenharia reversa: a IA pediu para olhar/alterar um binário. Executa no VS Code
            // e devolve o resultado como próxima mensagem (não conta como falha).
            const re = scanReRequests(p.messageText(answerNode));
            if (re.requests.length || re.errors.length) {
                let text = '';
                if (re.requests.length) {
                    window.DS.panel.toast(`🔬 Engenharia reversa: ${re.requests.length} pedido(s)... (a 1ª análise de uma DLL pode demorar)`);
                    const rr = await conn.requestRE(re.requests);
                    text = (rr && rr.text) || '(sem resposta do VS Code)';
                }
                failures = 0;
                promptText = buildReResultPrompt({
                    text,
                    errors: re.errors,
                    ignoredFiles: !!(parsed && parsed.files && parsed.files.length)
                });
                state.transition(STATES.RUNNING);
                continue;
            }

            if (parsed.error) {
                if (status === 'continue') {
                    failures++;
                    if (failures >= MAX_CONSECUTIVE_FAILURES) { window.DS.panel.toast('⏹ Sem arquivos repetidamente. Encerrado.'); return; }
                    await humanDelay(HUMAN_DELAY.afterFailure);
                    promptText = 'Você marcou [[STATUS:CONTINUAR]] mas não enviou arquivos. Envie agora os arquivos da próxima etapa (máx 20).';
                    continue;
                }
                const answerText = p.messageText(answerNode);
                const asked = !p.hasEndMarker(answerText) && !status &&
                    /(continu|prosseg|quer que|deseja|posso seguir|confirm)/i.test(answerText.slice(-300));
                if (asked) {
                    failures++;
                    if (failures >= MAX_CONSECUTIVE_FAILURES) { window.DS.panel.toast('⏹ Só pede confirmação. Encerrado.'); return; }
                    promptText = 'Sim, continue. Não peça confirmação. Reenvie a etapa em partes menores.';
                    continue;
                }
                window.DS.panel.toast('✅ Agente encerrado: modelo terminou sem arquivos.');
                return;
            }

            if (parsed.problems.length > 0) {
                failures++;
                if (failures >= MAX_CONSECUTIVE_FAILURES) { window.DS.panel.toast('⏹ Formato inválido repetido. Encerrado.'); return; }
                await humanDelay(HUMAN_DELAY.afterFailure);
                promptText = 'Sua resposta violou o contrato:\n' + parsed.problems.join('\n') + '\n\nReenvie corrigido.';
                continue;
            }

            window.DS.panel.toast(`🛠️ Aplicando ${parsed.files.length} operação(ões) e executando...`);
            state.transition(STATES.APPLYING);

            const res = await conn.applyFiles(parsed.files, {
                missionId: currentMissionId,
                runId: currentRunId,
                modelStatus: status
            });
            if (!res) { window.DS.panel.toast('VS Code não respondeu.'); return; }
            if (res.status === 'cancelled') { window.DS.panel.toast('Aplicação cancelada.'); return; }

            const touchedNow = (res.files && Array.isArray(res.files)) ? res.files : [];
            for (const f of touchedNow) agentTouched.add(f);

            const dur = res.runDurationMs ? ` (${(res.runDurationMs / 1000).toFixed(1)}s)` : '';

            if (res.nextAction) {
                const it = res.iteration || {};
                if (res.nextAction === 'stop') {
                    window.DS.panel.toast(`⏹ ${res.nextReason || 'Agente parado.'}`);
                    conn.updateState({ touched: [...agentTouched], lastFailure: res.nextReason || 'parado' });
                    state.transition(STATES.DONE);
                    return;
                }
                if (res.nextAction === 'done') {
                    conn.updateState({
                        touched: [...agentTouched],
                        working: [`Etapa ${stages + 1} aplicada${dur}`],
                        decisions: [`Agente concluiu ${stages + 1} etapa(s).`],
                        lastFailure: ''
                    });
                    window.DS.panel.toast(`✅ Agente concluiu! ${stages + 1} etapa(s)${dur}`);
                    state.transition(STATES.DONE);
                    return;
                }
                if (res.nextAction === 'retry') {
                    failures++;
                    const lastFailure = (it.errors && it.errors[0]) ||
                        (it.status === 'applied-build-failed' ? `Build falhou (exit ${it.runExitCode ?? '?'})` : 'falha');
                    conn.updateState({ touched: [...agentTouched], lastFailure });
                    await humanDelay(HUMAN_DELAY.afterFailure);
                    promptText = res.nextPrompt || 'Reenvie a etapa corrigida.';
                    state.transition(STATES.RUNNING);
                    continue;
                }
                // continue
                failures = 0;
                stages++;
                conn.updateState({ touched: [...agentTouched], working: [`Etapa ${stages} aplicada${dur}`], lastFailure: '' });
                promptText = res.nextPrompt || 'Continue com a próxima etapa.';
                state.transition(STATES.RUNNING);
                continue;
            }

            // Fallback (VS Code antigo)
            if (res.status === 'error') {
                failures++;
                if (failures >= MAX_CONSECUTIVE_FAILURES) { window.DS.panel.toast('⏹ Muitas falhas. Encerrado.'); return; }
                await humanDelay(HUMAN_DELAY.afterFailure);
                promptText = `Falha ao aplicar: ${res.message}\n\nReenvie os arquivos corrigidos (máx 20).`;
                state.transition(STATES.RUNNING);
                continue;
            }
            if (res.runSuccess === false) {
                failures++;
                if (failures >= MAX_CONSECUTIVE_FAILURES) { window.DS.panel.toast('⏹ Build falha persistente. Encerrado.'); return; }
                await humanDelay(HUMAN_DELAY.afterFailure);
                promptText = `Build falhou (exit ${res.runExitCode ?? '?'}):\n\`\`\`\n${(res.runOutput || '').slice(-12000)}\n\`\`\`\nCorrija.`;
                state.transition(STATES.RUNNING);
                continue;
            }

            failures = 0;
            stages++;
            if (status === 'continue') {
                window.DS.panel.toast(`✔ Etapa ${stages} aplicada${dur}.`);
                promptText = 'Etapa aplicada. Continue com a próxima. Termine com [[STATUS:CONCLUIDO]] quando terminar.';
                state.transition(STATES.RUNNING);
                continue;
            }
            conn.updateState({ decisions: [`Agente concluiu ${stages} etapa(s).`] });
            window.DS.panel.toast('✅ Agente concluiu!');
            state.transition(STATES.DONE);
            return;
        }

        if (agentRunning && state.iteration >= MAX_AGENT_ITERATIONS) {
            window.DS.panel.toast(`⏹ Limite de ${MAX_AGENT_ITERATIONS} iterações.`);
        }
    }

    window.DS.agent = {
        start,
        stop,
        resolveWaitMore,
        setInstantMode(v) { instantMode = !!v; },
        get running() { return agentRunning; }
    };
})();
