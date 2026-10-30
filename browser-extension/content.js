const WS_URL = 'ws://127.0.0.1:8765';

class BridgeSocket {
    constructor(token) {
        this.readyState = 0;
        this.onopen = null;
        this.onclose = null;
        this.onerror = null;
        this.onmessage = null;
        this.port = chrome.runtime.connect({ name: 'vscode-bridge' });
        this.port.onMessage.addListener(m => {
            if (m.t === 'open') { this.readyState = 1; this.onopen && this.onopen(); }
            else if (m.t === 'msg') { this.onmessage && this.onmessage({ data: m.data }); }
            else if (m.t === 'close') { this._finish(); }
        });
        this.port.onDisconnect.addListener(() => this._finish());
        try { this.port.postMessage({ t: 'init', token: token || '' }); } catch { /* ignore */ }
    }
    _finish() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.onclose && this.onclose();
    }
    send(data) { if (this.readyState === 1) this.port.postMessage({ t: 'send', data }); }
    close() { try { this.port.disconnect(); } catch { /* ignore */ } this._finish(); }
}

function siteName() { return window.DSProviderName || 'DeepSeek'; }

let ws = null;
let connected = false;
let waiting = null;
let waitingApplyResult = null;
let waitingSelection = null;
let waitingState = null;
let nextIsDelta = false;
let reconnectTimer = null;
let authToken = '';
let lastConnErrorAt = 0;

let currentTimeouts = { response: 600, run: 600, apply: 780 };

let rootEl = null;
let fab = null;
let fabIconEl = null;
let fabBadgeEl = null;
let panel = null;
let panelExpanded = false;
let statusDot = null;
let statusLabelEl = null;
let fullCodeToggle = null;
let fullBtn = null;
let applyBtn = null;
let selectBtn = null;
let newConvBtn = null;
let attachBtn = null;
let tokenBtn = null;
let timeoutSelect = null;
let moreBtn = null;
let toastEl = null;
let toastTimer = null;

let selPanel = null;
let selHeaderEl = null;
let selListEl = null;
let selApplyBtn = null;
let selCancelBtn = null;
let selectionState = null;

let fullCodeMode = false;
let agentRunning = false;
let agentIteration = 0;
let agentPaused = false;
let waitResolve = null;
let agentObjective = '';
let agentTouched = new Set();
let agentSuggestedNewChat = false;
const MAX_AGENT_ITERATIONS = 40;
const MAX_CONSECUTIVE_FAILURES = 6;
const SUGGEST_NEW_CHAT_AFTER = 20;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const HUMAN_DELAY = {
    warmup:            [1500, 3500],
    beforeSend:        [2000, 5000],
    afterSend:         [600, 1500],
    betweenContinue:   [2500, 5000],
    afterFailure:      [8000, 15000],
    afterSendFailed:   [20000, 40000],
    betweenResends:    [55000, 65000],
    maxContinueClicks: 5
};

function humanDelay(range) {
    const [min, max] = range;
    return sleep(Math.round(min + Math.random() * (max - min)));
}

async function waitBetweenResends() {
    const [min, max] = HUMAN_DELAY.betweenResends;
    const totalMs = Math.round(min + Math.random() * (max - min));
    const endAt = Date.now() + totalMs;
    while (agentRunning && Date.now() < endAt) {
        const remaining = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
        toast(`⏸️ Aguardando ${remaining}s antes do próximo envio (anti-spam)...`);
        const chunk = Math.min(5000, Math.max(250, endAt - Date.now()));
        await sleep(chunk);
    }
}

// ---------- Token ----------

async function loadToken() {
    try {
        const r = await chrome.storage.local.get(['vscodeToken']);
        authToken = (r && r.vscodeToken) || '';
    } catch { authToken = ''; }
}

async function saveToken(t) {
    authToken = (t || '').trim();
    try {
        if (authToken) await chrome.storage.local.set({ vscodeToken: authToken });
        else await chrome.storage.local.remove('vscodeToken');
    } catch { /* ignore */ }
}

async function promptToken() {
    const current = authToken ? authToken.slice(0, 6) + '…' + authToken.slice(-4) : '(nenhum)';
    const msg =
        `Token do VS Code (atual: ${current}).\n\n` +
        'No VS Code: Ctrl+Shift+P → "DeepSeek Context Sync: Copiar Token" e cole aqui.';
    const typed = prompt(msg, '');
    if (typed === null) return;
    await saveToken(typed);
    updateUI();
    if (!authToken) toast('Token removido. O VS Code vai recusar a conexão.');
    else toast('Token salvo. Reconectando...');
    try { ws && ws.close(); } catch { /* ignore */ }
    clearTimeout(reconnectTimer);
    setTimeout(connect, 500);
}

// ---------- Conexão ----------

function connect() {
    try { ws = new BridgeSocket(authToken); }
    catch (e) { scheduleReconnect(); return; }

    ws.onopen = () => {
        connected = true;
        nextIsDelta = false;
        updateUI();
        console.log('Conectado ao VS Code Context Sync');
    };

    ws.onclose = () => {
        connected = false;
        updateUI();
        finishWaiting(null);
        finishWaitingApply({ status: 'cancelled', message: 'Conexão com o VS Code foi fechada.' });
        finishWaitingSelection({ error: 'Conexão com o VS Code foi fechada.' });
        finishWaitingState(null);
        resolveWaitMore(false);
        agentRunning = false;

        const now = Date.now();
        if (now - lastConnErrorAt > 30000 && !authToken) {
            lastConnErrorAt = now;
            toast('🔑 Token não configurado. Clique em "🔑 Token" no painel para colar.');
        }
        scheduleReconnect();
    };

    ws.onerror = () => { /* onclose cuida */ };

    ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }

        if (msg.type === 'config' && msg.timeouts) {
            currentTimeouts = { ...currentTimeouts, ...msg.timeouts };
            updateUI();
        } else if (msg.type === 'context') {
            finishWaiting(msg);
        } else if (msg.type === 'applyResult') {
            const icon = msg.status === 'applied' ? '✅' : msg.status === 'cancelled' ? '⏹' : '❌';
            let text = `${icon} ${msg.message}`;
            if (typeof msg.runSuccess === 'boolean') text += msg.runSuccess ? ' (execução OK)' : ' (execução falhou)';
            toast(text);
            finishWaitingApply(msg);
        } else if (msg.type === 'selection') {
            finishWaitingSelection(msg);
        } else if (msg.type === 'selectionContext') {
            finishWaitingSelection(msg);
        } else if (msg.type === 'state') {
            finishWaitingState(msg);
        } else if (msg.type === 'aborted') {
            console.debug('[DeepSeek Sync] VS Code confirmou abort.');
        } else if (msg.type === 'error') {
            toast(`⚠️ ${msg.message || 'Erro'}`);
        }
    };
}

function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
}

function isOpen() { return connected && ws && ws.readyState === 1; }

function requestContext(mode) {
    return new Promise((resolve) => {
        if (!isOpen() || waiting) { resolve(null); return; }
        const timer = setTimeout(() => finishWaiting(null), 5000);
        waiting = { resolve, timer };
        ws.send(JSON.stringify({ type: 'request', mode }));
    });
}

function finishWaiting(msg) {
    if (!waiting) return;
    clearTimeout(waiting.timer);
    const resolve = waiting.resolve;
    waiting = null;
    resolve(msg);
}

function finishWaitingApply(msg) {
    if (!waitingApplyResult) return;
    clearTimeout(waitingApplyResult.timer);
    const resolve = waitingApplyResult.resolve;
    waitingApplyResult = null;
    resolve(msg);
}

function requestSelection(type, payload) {
    return new Promise((resolve) => {
        if (!isOpen()) { resolve({ error: 'Sem conexão com o VS Code.' }); return; }
        if (waitingSelection) { resolve({ error: 'Já existe uma seleção em andamento.' }); return; }
        const timer = setTimeout(() => finishWaitingSelection({ error: 'Timeout aguardando o VS Code.' }), 30000);
        waitingSelection = { resolve, timer };
        ws.send(JSON.stringify({ type, ...payload }));
    });
}

function finishWaitingSelection(msg) {
    if (!waitingSelection) return;
    clearTimeout(waitingSelection.timer);
    const resolve = waitingSelection.resolve;
    waitingSelection = null;
    resolve(msg);
}

function requestState() {
    return new Promise((resolve) => {
        if (!isOpen()) { resolve({ state: '' }); return; }
        if (waitingState) { resolve({ state: '' }); return; }
        const timer = setTimeout(() => finishWaitingState({ state: '' }), 5000);
        waitingState = { resolve, timer };
        ws.send(JSON.stringify({ type: 'getState' }));
    });
}

function finishWaitingState(msg) {
    if (!waitingState) return;
    clearTimeout(waitingState.timer);
    const resolve = waitingState.resolve;
    waitingState = null;
    resolve(msg || { state: '' });
}

function pushState(patch) {
    if (!isOpen()) return;
    try { ws.send(JSON.stringify({ type: 'updateState', patch })); } catch { /* ignore */ }
}

// ---------- Campo de texto (via provider) ----------

function getProvider() {
    if (window.DSProvider) return window.DSProvider;
    return {
        findInput: () => document.querySelector('#chat-input') || document.querySelector('textarea') || document.querySelector('[contenteditable="true"]'),
        readInput: (i) => i.tagName === 'TEXTAREA' ? i.value : (i.innerText || ''),
        setInput: (i, t) => {
            if (i.tagName === 'TEXTAREA') { i.value = t; i.dispatchEvent(new Event('input', { bubbles: true })); }
            else { i.focus(); document.execCommand('selectAll'); document.execCommand('insertText', false, t); }
        },
        pressSend: async () => false,
        snapshotAssistant: () => ({ count: 0, last: null }),
        findStopButton: () => null,
        findContinueButton: () => null
    };
}

function findInput() { return getProvider().findInput(); }
function readInput(input) { return getProvider().readInput(input); }
function setInput(input, text) { return getProvider().setInput(input, text); }
async function pressSend() { return getProvider().pressSend(); }

// ---------- Anexar contexto ----------

async function handleAttach(mode) {
    if (agentRunning) { toast('Aguarde o agente terminar ou pare-o.'); return; }

    const input = findInput();
    if (!input) { toast('Campo de entrada não encontrado. A página pode ter mudado.'); return; }

    const current = readInput(input);
    if (current.includes(PROMPT_MARKER)) {
        toast('O campo já contém um contexto anexado. Envie a mensagem (ou limpe o campo) antes de anexar de novo.');
        return;
    }
    const question = current.trim();

    toast('Buscando contexto...');
    const msg = await requestContext(mode);
    if (!msg) { toast('Sem resposta do VS Code. Deixe a janela com a extensão aberta e recarregue a página.'); return; }
    if (msg.mode === 'empty') { toast('Nenhuma alteração desde o último envio.'); return; }

    const kb = (msg.chars / 1024).toFixed(1);

    if (msg.mode === 'full') {
        setInput(input, buildFullPrompt({ tree: msg.tree, context: msg.data, question, fullCode: false }));
        nextIsDelta = true;
        let info = `Contexto completo: ${msg.files} arquivo(s), ${kb} KB.`;
        if (msg.omitted > 0) info += ` ${msg.omitted} omitido(s) por limite de tamanho.`;
        toast(info);
    } else {
        setInput(input, buildDeltaPrompt({ tree: msg.tree, changes: msg.data, question, fullCode: false }));
        let info = `Alterações: ${msg.files} arquivo(s), ${kb} KB.`;
        if (msg.tree) info += ' Estrutura atualizada.';
        if (msg.remaining > 0) info += ` Restam ${msg.remaining}; clique de novo para enviar.`;
        toast(info);
    }
    updateUI();
}

// ---------- Aplicar ----------

function handleApply() {
    if (agentRunning) { toast('Aguarde o agente terminar.'); return; }
    if (!isOpen()) { toast('Sem conexão com o VS Code.'); return; }

    const result = parseLastResponse();
    if (result.error) { toast(result.error); return; }
    if (result.problems.length > 0) {
        alert('O modelo não seguiu o contrato:\n\n' + result.problems.join('\n') + '\n\nNada será aplicado.');
        return;
    }

    ws.send(JSON.stringify({ type: 'applyFiles', files: result.files }));
    toast(`Aguardando confirmação no VS Code (${result.files.length} bloco(s))...`);
}

// ---------- Fase 2: seletivo ----------

async function handleSelectContext() {
    if (agentRunning) { toast('Aguarde o agente terminar.'); return; }
    if (fullCodeMode) { toast('O seletivo está disponível apenas no modo manual.'); return; }
    if (!isOpen()) { toast('Sem conexão com o VS Code.'); return; }

    const input = findInput();
    if (!input) { toast('Campo de entrada não encontrado.'); return; }

    const current = readInput(input);
    if (current.includes(PROMPT_MARKER)) {
        toast('O campo já contém contexto. Envie ou limpe antes de usar o seletivo.');
        return;
    }
    const question = current.trim();
    if (!question) { toast('Digite o pedido no chat antes de clicar em "🎯 Seletivo".'); return; }

    toast('Analisando arquivos relevantes...');
    const res = await requestSelection('selectContext', { request: question });
    if (!res) { toast('Sem resposta do VS Code.'); return; }
    if (res.error) { toast('⚠️ ' + res.error); return; }
    if (!res.files || res.files.length === 0) { toast('Nenhum arquivo corresponde ao pedido.'); return; }

    showSelection(res.files, res.total, question);
}

function showSelection(files, total, request) {
    selectionState = { files, total, request };
    if (!selPanel || !selListEl || !selHeaderEl) return;

    selListEl.textContent = '';
    for (const f of files) {
        const label = document.createElement('label');
        label.className = 'ds-sel-item';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.dataset.path = f.path;
        cb.dataset.tokens = String(f.tokens || 0);
        cb.addEventListener('change', updateSelHeader);

        const body = document.createElement('div');
        body.className = 'ds-sel-body';

        const nameEl = document.createElement('span');
        nameEl.className = 'ds-sel-name';
        nameEl.textContent = f.path;

        const metaEl = document.createElement('span');
        metaEl.className = 'ds-sel-meta';
        const reasons = (f.reasons && f.reasons.length > 0) ? ' · ' + f.reasons.join(', ') : '';
        metaEl.textContent = `~${f.tokens || 0} tok${reasons}`;

        body.append(nameEl, metaEl);
        label.append(cb, body);
        selListEl.appendChild(label);
    }

    updateSelHeader();
    selPanel.classList.add('ds-visible');
    panel?.classList.add('ds-selecting');
    updateUI();
}

function updateSelHeader() {
    if (!selHeaderEl || !selListEl) return;
    let checked = 0;
    let tokens = 0;
    let count = 0;
    for (const cb of selListEl.querySelectorAll('input[type="checkbox"]')) {
        count++;
        if (cb.checked) { checked++; tokens += Number(cb.dataset.tokens || 0); }
    }
    selHeaderEl.textContent = `🎯 ${checked}/${count} arquivos · ~${(tokens / 1000).toFixed(1)}k tokens`;
    if (selApplyBtn) {
        selApplyBtn.textContent = `✔ Aplicar (${checked}/${count})`;
        selApplyBtn.disabled = checked === 0;
    }
}

async function applySelection() {
    if (!selListEl) return;
    const paths = [];
    for (const cb of selListEl.querySelectorAll('input[type="checkbox"]')) if (cb.checked) paths.push(cb.dataset.path);
    if (paths.length === 0) { toast('Selecione pelo menos um arquivo.'); return; }

    if (selApplyBtn) { selApplyBtn.disabled = true; selApplyBtn.textContent = '⏳ Montando...'; }
    const res = await requestSelection('buildSelection', { paths });
    if (!res) { toast('Sem resposta do VS Code.'); updateSelHeader(); return; }
    if (res.error) { toast('⚠️ ' + res.error); updateSelHeader(); return; }

    const input = findInput();
    if (!input) { toast('Campo de entrada perdido.'); updateSelHeader(); return; }

    const question = (selectionState && selectionState.request) || '';
    setInput(input, buildFullPrompt({ tree: res.tree, context: res.data, question, fullCode: false }));
    nextIsDelta = true;

    const kTokens = ((res.tokens || 0) / 1000).toFixed(1);
    let extra = (res.skeleton && res.skeleton.length > 0) ? ` (${res.skeleton.length} só como esqueleto)` : '';
    if (res.missing && res.missing.length > 0) extra += ` ⚠️ ${res.missing.length} sem conteúdo no VS Code: ${res.missing.slice(0, 3).join(', ')}`;
    toast(`🎯 Contexto seletivo: ${res.files} arquivo(s)${extra}, ~${kTokens}k tokens.`);
    hideSelection();
    updateUI();
}

function hideSelection() {
    selectionState = null;
    if (selPanel) selPanel.classList.remove('ds-visible');
    if (selListEl) selListEl.textContent = '';
    if (selHeaderEl) selHeaderEl.textContent = '';
    panel?.classList.remove('ds-selecting');
    updateUI();
}

// ---------- Fase 5: nova conversa ----------

async function handleNewConversation() {
    if (!isOpen()) { toast('Sem conexão com o VS Code.'); return; }

    if (agentRunning) {
        toast('⏹ Parando o agente antes de abrir uma conversa nova...');
        stopAgent();
        await sleep(800);
    }

    const stateRes = await requestState();
    const stateText = (stateRes && stateRes.state) || '';

    const handoff =
        '[CONTINUAÇÃO DE TRABALHO]\n\n' +
        (stateText ? stateText + '\n\n' : '') +
        'Este é um resumo do estado do projeto (Objetivo, Plano, Funciona, Quebrado, Decisões, Rollbacks, Última falha). ' +
        'Use-o como contexto. Quando eu enviar o próximo pedido, você já saberá o que foi feito, o que quebrou e os próximos passos.\n';

    try { await chrome.storage.local.set({ pendingPrompt: handoff }); }
    catch { /* ignore */ }

    window.open(getProvider().newChatUrl || (location.origin + '/'), '_blank');
    toast('🆕 Nova conversa aberta. O estado será colado automaticamente no campo.');
}

// ---------- Utilidades do agente ----------

function isVisible(el) { return window.isVisible ? window.isVisible(el) : true; }
function findStopButton() { return getProvider().findStopButton(); }
function findContinueButton() { return getProvider().findContinueButton(); }
function snapshotAssistant() { return getProvider().snapshotAssistant(); }

function showWaitMoreButton() {
    return new Promise((resolve) => {
        waitResolve = resolve;
        agentPaused = true;
        updateUI();
        toast('⏱️ Timeout: clique em "Esperar mais" (no painel) para continuar ou "Parar" para encerrar.');
    });
}

function resolveWaitMore(cont) {
    if (!waitResolve) return;
    const r = waitResolve;
    waitResolve = null;
    agentPaused = false;
    updateUI();
    r(cont);
}

async function waitForResponseComplete(timeoutMs, baseline, askExtend) {
    const initialCount = baseline.count;
    const initialLast = baseline.last;
    {
        const start = Date.now();
        let appeared = false;
        while (Date.now() - start < 120000) {
            if (!agentRunning) return false;
            await sleep(200);
            const now = snapshotAssistant();
            if (now.count > initialCount || (now.last && now.last !== initialLast)) { appeared = true; break; }
        }
        if (!appeared) return false;
    }
    while (true) {
        const phaseStart = Date.now();
        let lastText = '';
        let stableSince = Date.now();
        let continueClicks = 0;
        while (Date.now() - phaseStart < timeoutMs) {
            if (!agentRunning) return false;
            const text = messageText(findLastAssistantMessage());
            if (text !== lastText) { lastText = text; stableSince = Date.now(); }
            const stableFor = Date.now() - stableSince;
            const ended = hasEndMarker(text);
            const status = readStatus(text);
            if (ended && stableFor > 1200) return true;
            if (!ended && stableFor > 1500 && continueClicks < HUMAN_DELAY.maxContinueClicks) {
                const btn = findContinueButton();
                if (btn) {
                    continueClicks++;
                    toast(`⏩ Resposta cortada pelo site: clicando em "Continuar" (${continueClicks}/${HUMAN_DELAY.maxContinueClicks})...`);
                    btn.click();
                    stableSince = Date.now();
                    await humanDelay(HUMAN_DELAY.betweenContinue);
                    continue;
                }
            }
            const needed = status === 'done' ? 2500 : 8000;
            if (stableFor > needed && lastText.trim().length > 10 && !findStopButton()) return true;
            await sleep(300);
        }
        if (!askExtend) return false;
        const more = await askExtend();
        if (!more) return false;
    }
}

function sendApplyAndRun(files) {
    return new Promise((resolve) => {
        if (!isOpen()) { resolve(null); return; }
        if (waitingApplyResult) { resolve(null); return; }
        const timer = setTimeout(() => {
            finishWaitingApply({ status: 'error', message: 'Timeout aguardando VS Code (apply+run).' });
        }, currentTimeouts.apply * 1000);
        waitingApplyResult = { resolve, timer };
        ws.send(JSON.stringify({ type: 'applyFiles', files, autoApply: true, runAfter: true }));
    });
}

// ---------- Agente Full Code ----------

function stopAgent() {
    agentRunning = false;
    resolveWaitMore(false);
    try { if (isOpen()) ws.send(JSON.stringify({ type: 'abort' })); } catch { /* ignore */ }
    finishWaitingApply({ status: 'cancelled', message: 'Agente parado pelo usuário.' });
    toast('⏹ Agente parado.');
    updateUI();
}

async function startAgent() {
    if (!isOpen()) {
        toast(authToken ? 'Sem conexão com o VS Code.' : '🔑 Token não configurado. Clique em "🔑 Token" no painel.');
        return;
    }
    if (agentRunning) { toast('Agente já está rodando.'); return; }

    const input = findInput();
    if (!input) { toast('Campo de entrada não encontrado.'); return; }
    const current = readInput(input);
    if (current.includes(PROMPT_MARKER)) {
        toast('O campo já contém contexto. Limpe e escreva sua pergunta.');
        return;
    }
    const question = current.trim();
    if (!question) { toast('Digite a pergunta antes de rodar o agente.'); return; }

    agentRunning = true;
    agentIteration = 0;
    agentObjective = question;
    agentTouched = new Set();
    agentSuggestedNewChat = false;

    // Fase 5 — schema do state.md: Objetivo / Plano / Funciona / Quebrado /
    // Decisões / Rollbacks / Última falha / Arquivos tocados.
    pushState({
        objective: question.slice(0, 1500),
        plan: [],
        working: [],
        broken: [],
        lastFailure: ''
    });

    updateUI();
    try { await agentLoop(question); }
    catch (e) { toast('Erro no agente: ' + (e instanceof Error ? e.message : String(e))); }
    finally { agentRunning = false; agentPaused = false; updateUI(); }
}

async function agentLoop(initialQuestion) {
    let promptText = initialQuestion;
    let needContext = true;
    let failures = 0;
    let stages = 0;
    let isFirstIteration = true;

    await humanDelay(HUMAN_DELAY.warmup);

    while (agentRunning && agentIteration < MAX_AGENT_ITERATIONS) {
        if (!agentRunning) return;
        if (!isFirstIteration) {
            await waitBetweenResends();
            if (!agentRunning) return;
        }
        isFirstIteration = false;

        agentIteration++;
        updateUI();
        toast(`⏳ Iteração ${agentIteration}/${MAX_AGENT_ITERATIONS}...`);

        if (agentIteration === SUGGEST_NEW_CHAT_AFTER && !agentSuggestedNewChat) {
            agentSuggestedNewChat = true;
            toast('💡 Sugestão: após 20 iterações o chat pode ficar lento. Termine a etapa atual e clique em "🆕 Nova conversa" quando fizer sentido.');
        }

        let textToSend = promptText;
        if (needContext) {
            const msg = await requestContext('auto');
            if (!msg) { toast('VS Code não respondeu ao pedido de contexto.'); return; }
            if (msg.mode === 'empty') {
                textToSend = buildDeltaPrompt({ tree: undefined, changes: '', question: promptText, fullCode: true });
            } else if (msg.mode === 'full') {
                textToSend = buildFullPrompt({ tree: msg.tree, context: msg.data, question: promptText, fullCode: true });
                nextIsDelta = true;
            } else {
                textToSend = buildDeltaPrompt({ tree: msg.tree, changes: msg.data, question: promptText, fullCode: true });
            }
            needContext = false;
        }

        const input = findInput();
        if (!input) { toast('Campo de entrada perdido.'); return; }
        await humanDelay(HUMAN_DELAY.beforeSend);

        const baseline = snapshotAssistant();
        setInput(input, textToSend);
        await sleep(150);

        const sent = await pressSend();
        if (!sent) {
            toast('⚠️ Envio falhou (possível limite de requisições do site). Aguardando...');
            await humanDelay(HUMAN_DELAY.afterSendFailed);
            toast('⏹ Encerrado para não piorar o bloqueio. Aguarde alguns minutos e clique em "Rodar agente" de novo.');
            pushState({ lastFailure: 'Envio falhou — possível limite de requisições do site.' });
            return;
        }

        await humanDelay(HUMAN_DELAY.afterSend);
        toast(`💬 Iteração ${agentIteration}: aguardando o ${siteName()}...`);
        const ok = await waitForResponseComplete(currentTimeouts.response * 1000, baseline, showWaitMoreButton);
        if (!ok) {
            if (!agentRunning) return;
            toast(`Timeout: não detectei a resposta do ${siteName()} terminar.`);
            pushState({ lastFailure: `Timeout aguardando a resposta do ${siteName()}.` });
            return;
        }
        await sleep(800);

        const answerNode = findLastAssistantMessage();
        if (!answerNode) { toast('Não encontrei a resposta na página.'); return; }
        const status = readStatus(messageText(answerNode));
        const parsed = parseLastResponse();

        if (parsed.error) {
            if (status === 'continue') {
                failures++;
                if (failures >= MAX_CONSECUTIVE_FAILURES) { toast('⏹ O modelo não está enviando arquivos. Encerrado.'); return; }
                await humanDelay(HUMAN_DELAY.afterFailure);
                promptText = 'Você indicou ' + STATUS_CONTINUE + ' mas não enviou nenhum bloco "### FILE:" ou "EDIT:". ' +
                    'Envie agora os arquivos COMPLETOS da próxima etapa (máximo 20).';
                continue;
            }
            const answerText = messageText(answerNode);
            const asked = !hasEndMarker(answerText) && !status && /(continu|prosseg|quer que|deseja|posso seguir|confirm)/i.test(answerText.slice(-300));
            if (asked) {
                failures++;
                if (failures >= MAX_CONSECUTIVE_FAILURES) { toast('⏹ O modelo só pede confirmação e não envia arquivos. Encerrado.'); return; }
                toast('↪ O modelo pediu confirmação/foi cortado: respondendo "continuar" sozinho...');
                await humanDelay(HUMAN_DELAY.afterFailure);
                promptText = 'Sim, continue. Não peça confirmação. Se sua resposta anterior foi cortada, reenvie a etapa em partes ' +
                    'menores (no máximo 4 arquivos COMPLETOS por resposta). Termine com ' + STATUS_CONTINUE + ' ou ' + STATUS_DONE +
                    ' e depois ' + END_MARKER + '.';
                continue;
            }
            toast(`✅ Agente encerrado: o modelo terminou sem novos arquivos. (${stages} etapa(s) aplicada(s))`);
            return;
        }

        if (parsed.problems.length > 0) {
            failures++;
            if (failures >= MAX_CONSECUTIVE_FAILURES) { toast('⏹ O modelo continua violando o formato. Encerrado.'); return; }
            await humanDelay(HUMAN_DELAY.afterFailure);
            promptText = 'Sua resposta anterior violou o contrato:\n' + parsed.problems.join('\n') +
                '\n\nReenvie os arquivos COMPLETOS no formato "### FILE:" ou "EDIT:" (máximo 20 por resposta), ' +
                'terminando com ' + STATUS_CONTINUE + ' ou ' + STATUS_DONE + ' e depois ' + END_MARKER + '.';
            continue;
        }

        toast(`🛠️ Aplicando ${parsed.files.length} operação(ões) e executando...`);
        const res = await sendApplyAndRun(parsed.files);
        if (!res) { toast('VS Code não respondeu.'); return; }
        if (res.status === 'cancelled') { toast('Aplicação cancelada.'); return; }

        const touchedNow = (res.files && Array.isArray(res.files)) ? res.files : [];
        for (const f of touchedNow) agentTouched.add(f);

        if (res.status === 'error') {
            failures++;
            pushState({
                touched: [...agentTouched],
                lastFailure: `Falha ao aplicar: ${res.message}`,
                broken: [`Aplicação falhou: ${res.message}`]
            });
            if (failures >= MAX_CONSECUTIVE_FAILURES) { toast('⏹ Muitas falhas seguidas ao aplicar. Encerrado: ' + res.message); return; }
            await humanDelay(HUMAN_DELAY.afterFailure);
            promptText = `Falha ao aplicar: ${res.message}\n\nReenvie os arquivos corrigidos (máximo 20 por resposta).`;
            continue;
        }

        if (res.runSuccess === false) {
            failures++;
            const out = (res.runOutput || '').slice(-12000);
            pushState({
                touched: [...agentTouched],
                lastFailure: `Build/teste falhou (exit ${res.runExitCode ?? '?'}). Comando: ${res.runCommand || '(desconhecido)'}.`,
                broken: [`Build falhou na etapa ${stages + 1}: ${(res.runOutput || '').slice(-300)}`]
            });
            if (failures >= MAX_CONSECUTIVE_FAILURES) { toast('⏹ A execução continua falhando após várias correções. Encerrado.'); return; }
            await humanDelay(HUMAN_DELAY.afterFailure);
            promptText =
                'Os arquivos foram aplicados mas a execução falhou.\n\n' +
                `Comando: ${res.runCommand || '(desconhecido)'}` +
                (typeof res.runExitCode === 'number' ? ` (código de saída ${res.runExitCode})` : '') + '\n' +
                'Saída:\n```\n' + out + '\n```\n\n' +
                'Corrija e reenvie os arquivos COMPLETOS no formato "### FILE:" ou "EDIT:" (máximo 20 por resposta). ' +
                'Termine com ' + STATUS_CONTINUE + ' ou ' + STATUS_DONE + ' e depois ' + END_MARKER + '.';
            continue;
        }

        failures = 0;
        stages++;
        const dur = res.runDurationMs ? ` (${(res.runDurationMs / 1000).toFixed(1)}s)` : '';

        pushState({
            touched: [...agentTouched],
            working: [`Etapa ${stages} aplicada e build OK${dur}`],
            lastFailure: ''
        });

        if (status === 'continue') {
            toast(`✔ Etapa ${stages} aplicada${dur}. Pedindo a próxima...`);
            const outTail = (res.runOutput || '').slice(-1500);
            promptText =
                `Etapa aplicada com sucesso. Execução OK${res.runCommand ? ` (comando: ${res.runCommand})` : ''}.\n` +
                (outTail ? 'Saída:\n```\n' + outTail + '\n```\n\n' : '\n') +
                'Continue com a PRÓXIMA etapa do seu plano (arquivos COMPLETOS ou EDIT:, máximo 20). ' +
                'Quando a aplicação estiver completa e funcionando, termine com ' + STATUS_DONE + '. ' +
                'Termine sempre com ' + END_MARKER + '.';
            continue;
        }

        // Concluído: o agente marca a decisão final em `decisions`.
        pushState({
            decisions: [`Agente concluiu ${stages} etapa(s).`]
        });
        toast(`✅ Agente concluiu! ${stages} etapa(s) aplicada(s)${dur}`);
        return;
    }

    if (agentRunning && agentIteration >= MAX_AGENT_ITERATIONS) {
        toast(`⏹ Limite de ${MAX_AGENT_ITERATIONS} iterações atingido.`);
    }
}

// ---------- Interface ----------

function injectStyles() {
    if (document.getElementById('ds-sync-styles')) return;
    const style = document.createElement('style');
    style.id = 'ds-sync-styles';
    style.textContent = `
        #ds-sync-root {
            position: fixed; bottom: 110px; right: 16px; z-index: 2147483646;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 12px; color: #e8eaed; display: flex; flex-direction: column;
            align-items: flex-end; gap: 8px; pointer-events: none;
        }
        #ds-sync-root > * { pointer-events: auto; }
        .ds-toast {
            max-width: 300px; padding: 7px 10px; background: rgba(32, 33, 36, 0.96);
            border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 8px;
            font-size: 11.5px; color: #e8eaed; line-height: 1.35;
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4); display: none;
            word-break: break-word; pointer-events: none;
        }
        .ds-toast.ds-visible { display: block; }
        .ds-panel {
            position: relative; display: none; flex-direction: column; gap: 6px;
            padding: 10px; background: rgba(32, 33, 36, 0.96);
            border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45); min-width: 220px;
        }
        .ds-panel.ds-open { display: flex; animation: ds-fadeIn 0.15s ease-out; }
        .ds-panel.ds-selecting { min-width: 380px; max-width: 460px; }
        @keyframes ds-fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
        .ds-close {
            position: absolute; top: 4px; right: 6px; background: transparent; border: none;
            color: #9aa0a6; font-size: 15px; cursor: pointer; padding: 0 4px; line-height: 1;
        }
        .ds-close:hover { color: #e8eaed; }
        .ds-row { display: flex; gap: 6px; align-items: center; }
        .ds-status { display: flex; align-items: center; gap: 6px; padding: 0 2px 4px; font-size: 11px; color: #9aa0a6; }
        .ds-status-dot { width: 6px; height: 6px; border-radius: 50%; background: #ea4335; flex-shrink: 0; }
        .ds-status.ds-connected .ds-status-dot { background: #34a853; }
        .ds-btn {
            flex: 1; padding: 7px 10px; border: 1px solid transparent; border-radius: 8px;
            background: rgba(255, 255, 255, 0.06); color: #e8eaed; cursor: pointer;
            font-size: 12px; font-weight: 500; font-family: inherit; line-height: 1.2;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            transition: background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
        }
        .ds-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.12); }
        .ds-btn:active:not(:disabled) { background: rgba(255, 255, 255, 0.16); }
        .ds-btn:disabled { opacity: 0.45; cursor: not-allowed; }
        .ds-btn.ds-primary { background: #1a73e8; color: #fff; }
        .ds-btn.ds-primary:hover:not(:disabled) { background: #1765cc; }
        .ds-btn.ds-danger { background: #c62828; color: #fff; }
        .ds-btn.ds-danger:hover:not(:disabled) { background: #b71c1c; }
        .ds-btn.ds-warning { background: #ff6d00; color: #fff; }
        .ds-btn.ds-warning:hover:not(:disabled) { background: #e56200; }
        .ds-btn.ds-success { background: #2e7d32; color: #fff; }
        .ds-btn.ds-success:hover:not(:disabled) { background: #256428; }
        .ds-btn.ds-ghost { background: transparent; border-color: rgba(255, 255, 255, 0.12); color: #9aa0a6; }
        .ds-btn.ds-ghost:hover:not(:disabled) { color: #e8eaed; border-color: rgba(255, 255, 255, 0.22); background: rgba(255, 255, 255, 0.04); }
        .ds-select {
            flex: 0 0 auto; padding: 7px 6px; border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 8px; background: rgba(255, 255, 255, 0.06); color: #e8eaed;
            cursor: pointer; font-size: 11.5px; font-family: inherit; min-width: 80px; max-width: 92px;
        }
        .ds-select:focus { outline: 1px solid #1a73e8; }
        .ds-sel { display: none; flex-direction: column; gap: 4px; padding-top: 6px; border-top: 1px solid rgba(255, 255, 255, 0.1); }
        .ds-sel.ds-visible { display: flex; }
        .ds-sel-header { font-size: 11px; color: #9aa0a6; padding: 2px 0; }
        .ds-sel-list {
            max-height: 320px; overflow-y: auto; border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 6px; padding: 4px; background: rgba(0, 0, 0, 0.15);
        }
        .ds-sel-item { display: flex; gap: 6px; padding: 4px 6px; border-radius: 4px; font-size: 11px; cursor: pointer; align-items: flex-start; line-height: 1.3; }
        .ds-sel-item:hover { background: rgba(255, 255, 255, 0.06); }
        .ds-sel-item input { margin-top: 2px; flex-shrink: 0; }
        .ds-sel-body { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
        .ds-sel-name { color: #e8eaed; word-break: break-all; }
        .ds-sel-meta { color: #9aa0a6; font-size: 10px; word-break: break-word; }
        .ds-sel-actions { display: flex; gap: 6px; margin-top: 4px; }
        .ds-fab {
            width: 36px; height: 36px; border-radius: 50%; border: 1px solid rgba(255, 255, 255, 0.12);
            background: rgba(32, 33, 36, 0.92); color: #e8eaed; cursor: pointer;
            display: flex; align-items: center; justify-content: center; position: relative;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35); transition: transform 0.15s ease, background 0.15s ease;
            font-size: 16px; line-height: 1; padding: 0;
        }
        .ds-fab:hover { background: rgba(60, 64, 67, 0.95); transform: scale(1.06); }
        .ds-fab .ds-fab-dot {
            position: absolute; top: 2px; right: 2px; width: 8px; height: 8px; border-radius: 50%;
            border: 1.5px solid rgba(32, 33, 36, 0.95); background: #ea4335;
        }
        .ds-fab.ds-connected .ds-fab-dot { background: #34a853; }
        .ds-fab .ds-fab-badge {
            position: absolute; bottom: -4px; right: -4px; background: #ff6d00; color: #fff;
            font-size: 9px; font-weight: 700; border-radius: 8px; padding: 1px 5px;
            min-width: 14px; text-align: center; line-height: 1.3; display: none;
            border: 1.5px solid rgba(32, 33, 36, 0.95);
        }
        .ds-fab.ds-busy .ds-fab-badge { display: block; }
        .ds-fab.ds-busy { animation: ds-pulse 1.6s ease-in-out infinite; }
        @keyframes ds-pulse {
            0%, 100% { box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35); }
            50% { box-shadow: 0 0 0 4px rgba(255, 109, 0, 0.28); }
        }
    `;
    document.head.appendChild(style);
}

function toast(text) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.classList.add('ds-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.classList.remove('ds-visible'); }, 6000);
}

function togglePanel() {
    panelExpanded = !panelExpanded;
    if (panel) panel.classList.toggle('ds-open', panelExpanded);
    updateUI();
}

function updateUI() {
    if (!fab || !panel) return;
    fab.classList.toggle('ds-connected', connected);
    fab.classList.toggle('ds-busy', agentRunning);
    if (fabIconEl) fabIconEl.textContent = agentRunning ? '⏳' : (connected ? '🤖' : '⚠️');
    if (fabBadgeEl) fabBadgeEl.textContent = String(agentIteration);

    const statusRow = statusDot?.parentElement;
    if (statusRow) statusRow.classList.toggle('ds-connected', connected);
    if (statusLabelEl) {
        statusLabelEl.textContent = connected
            ? (agentPaused ? `Pausado (timeout) · iter. ${agentIteration}`
                : agentRunning ? `Agente rodando · iter. ${agentIteration}`
                : 'Conectado ao VS Code')
            : (authToken ? 'Desconectado do VS Code' : 'Token não configurado');
    }

    if (fullCodeToggle) {
        fullCodeToggle.classList.toggle('ds-warning', fullCodeMode);
        fullCodeToggle.classList.toggle('ds-ghost', !fullCodeMode);
        fullCodeToggle.textContent = fullCodeMode ? '🔁 Full Code ✓' : '🔁 Full Code';
    }

    if (attachBtn) {
        attachBtn.classList.remove('ds-primary', 'ds-warning', 'ds-danger');
        if (agentRunning) {
            attachBtn.textContent = `⏹ Parar (${agentIteration})`;
            attachBtn.classList.add('ds-danger');
        } else if (fullCodeMode) {
            attachBtn.textContent = '🚀 Rodar agente';
            attachBtn.classList.add('ds-warning');
        } else {
            attachBtn.textContent = nextIsDelta ? '📎 Anexar alterações' : '📎 Anexar contexto';
            attachBtn.classList.add('ds-primary');
        }
    }

    if (applyBtn) applyBtn.disabled = agentRunning || !connected;
    if (fullBtn) fullBtn.disabled = agentRunning;
    if (selectBtn) {
        selectBtn.disabled = !(!agentRunning && !fullCodeMode && connected);
        selectBtn.title = fullCodeMode ? 'O seletivo está disponível apenas no modo manual.' : 'Escolhe os arquivos relevantes para o pedido atual.';
    }
    if (newConvBtn) {
        newConvBtn.disabled = !connected;
        newConvBtn.title = agentRunning
            ? 'Para o agente e abre uma conversa nova com o estado do projeto.'
            : 'Abre uma conversa nova com o estado atual no campo.';
    }

    if (tokenBtn) {
        tokenBtn.classList.toggle('ds-ghost', !authToken);
        tokenBtn.classList.toggle('ds-success', !!authToken);
        tokenBtn.textContent = authToken ? '🔑 Token ✓' : '🔑 Token';
    }
    if (moreBtn) { moreBtn.style.display = agentPaused ? '' : 'none'; moreBtn.disabled = !agentPaused; }
    if (timeoutSelect) {
        const v = String(currentTimeouts.response);
        if (Array.from(timeoutSelect.options).some(o => o.value === v)) timeoutSelect.value = v;
    }

}

function addUI() {
    injectStyles();

    rootEl = document.createElement('div');
    rootEl.id = 'ds-sync-root';

    toastEl = document.createElement('div');
    toastEl.className = 'ds-toast';

    panel = document.createElement('div');
    panel.className = 'ds-panel';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ds-close';
    closeBtn.textContent = '×';
    closeBtn.title = 'Fechar';
    closeBtn.onclick = togglePanel;

    const statusRow = document.createElement('div');
    statusRow.className = 'ds-status';
    statusDot = document.createElement('span');
    statusDot.className = 'ds-status-dot';
    statusLabelEl = document.createElement('span');
    statusLabelEl.textContent = siteName() + ' Sync';
    statusRow.append(statusDot, statusLabelEl);

    fullCodeToggle = document.createElement('button');
    fullCodeToggle.type = 'button';
    fullCodeToggle.className = 'ds-btn ds-ghost';
    fullCodeToggle.textContent = '🔁 Full Code';
    fullCodeToggle.onclick = () => {
        if (agentRunning) { toast('Pare o agente antes de alternar o modo.'); return; }
        fullCodeMode = !fullCodeMode;
        updateUI();
        toast(fullCodeMode ? '🔁 Full Code ATIVO: enviará, aplicará e executará automaticamente.' : '⏹ Full Code desativado.');
    };

    fullBtn = document.createElement('button');
    fullBtn.type = 'button';
    fullBtn.className = 'ds-btn ds-ghost';
    fullBtn.textContent = '🔄 Contexto';
    fullBtn.title = 'Reenvia o projeto inteiro (use em uma conversa nova)';
    fullBtn.onclick = () => handleAttach('full');

    applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'ds-btn ds-success';
    applyBtn.textContent = '📥 Aplicar';
    applyBtn.title = 'Aplica no VS Code os blocos FILE:/EDIT: da última resposta.';
    applyBtn.onclick = handleApply;

    selectBtn = document.createElement('button');
    selectBtn.type = 'button';
    selectBtn.className = 'ds-btn ds-primary';
    selectBtn.textContent = '🎯 Seletivo';
    selectBtn.title = 'Escolhe os arquivos relevantes para o pedido atual.';
    selectBtn.onclick = handleSelectContext;

    timeoutSelect = document.createElement('select');
    timeoutSelect.className = 'ds-select';
    timeoutSelect.title = 'Timeout do agente (resposta e execução)';
    for (const v of [60, 300, 600]) {
        const opt = document.createElement('option');
        opt.value = String(v);
        opt.textContent = v === 60 ? '⏱ 1 min' : v === 300 ? '⏱ 5 min' : '⏱ 10 min';
        timeoutSelect.appendChild(opt);
    }
    timeoutSelect.onchange = () => {
        const value = Number(timeoutSelect.value);
        if (![60, 300, 600].includes(value)) return;
        if (!isOpen()) { toast('Sem conexão com o VS Code para salvar o timeout.'); return; }
        ws.send(JSON.stringify({ type: 'setTimeout', which: 'agent', value }));
        toast(`⏱ Timeout alterado para ${value / 60} min.`);
    };

    moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'ds-btn ds-warning';
    moreBtn.textContent = '⏱ Esperar mais';
    moreBtn.style.display = 'none';
    moreBtn.onclick = () => resolveWaitMore(true);

    newConvBtn = document.createElement('button');
    newConvBtn.type = 'button';
    newConvBtn.className = 'ds-btn ds-ghost';
    newConvBtn.textContent = '🆕 Nova conversa';
    newConvBtn.title = 'Abre uma conversa nova com o estado do projeto no campo.';
    newConvBtn.onclick = handleNewConversation;

    attachBtn = document.createElement('button');
    attachBtn.type = 'button';
    attachBtn.className = 'ds-btn ds-primary';
    attachBtn.onclick = () => {
        if (agentRunning) stopAgent();
        else if (fullCodeMode) startAgent();
        else handleAttach('auto');
    };

    tokenBtn = document.createElement('button');
    tokenBtn.type = 'button';
    tokenBtn.className = 'ds-btn ds-ghost';
    tokenBtn.textContent = '🔑 Token';
    tokenBtn.title = 'Colar o token gerado no VS Code (Ctrl+Shift+P → "Copiar Token")';
    tokenBtn.onclick = promptToken;

    selPanel = document.createElement('div');
    selPanel.className = 'ds-sel';
    selHeaderEl = document.createElement('div');
    selHeaderEl.className = 'ds-sel-header';
    selListEl = document.createElement('div');
    selListEl.className = 'ds-sel-list';
    const selActions = document.createElement('div');
    selActions.className = 'ds-sel-actions';
    selApplyBtn = document.createElement('button');
    selApplyBtn.type = 'button';
    selApplyBtn.className = 'ds-btn ds-success';
    selApplyBtn.textContent = '✔ Aplicar';
    selApplyBtn.onclick = applySelection;
    selCancelBtn = document.createElement('button');
    selCancelBtn.type = 'button';
    selCancelBtn.className = 'ds-btn ds-ghost';
    selCancelBtn.textContent = '✖ Cancelar';
    selCancelBtn.onclick = () => { hideSelection(); toast('Seleção cancelada.'); };
    selActions.append(selApplyBtn, selCancelBtn);
    selPanel.append(selHeaderEl, selListEl, selActions);

    const row1 = document.createElement('div'); row1.className = 'ds-row'; row1.append(fullCodeToggle);
    const row2 = document.createElement('div'); row2.className = 'ds-row'; row2.append(fullBtn, applyBtn);
    const row3 = document.createElement('div'); row3.className = 'ds-row'; row3.append(selectBtn, timeoutSelect);
    const row4 = document.createElement('div'); row4.className = 'ds-row'; row4.append(attachBtn);
    const rowPause = document.createElement('div'); rowPause.className = 'ds-row'; rowPause.append(moreBtn);
    const row5 = document.createElement('div'); row5.className = 'ds-row'; row5.append(newConvBtn);
    const row6 = document.createElement('div'); row6.className = 'ds-row'; row6.append(tokenBtn);

    panel.append(closeBtn, statusRow, row1, row2, row3, row4, rowPause, selPanel, row5, row6);

    fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'ds-fab';
    fab.title = siteName() + ' Sync (clique para abrir)';

    fabIconEl = document.createElement('span');
    fabIconEl.textContent = '🤖';

    const fabDot = document.createElement('span');
    fabDot.className = 'ds-fab-dot';

    fabBadgeEl = document.createElement('span');
    fabBadgeEl.className = 'ds-fab-badge';
    fabBadgeEl.textContent = '0';

    fab.append(fabIconEl, fabDot, fabBadgeEl);
    fab.onclick = togglePanel;

    rootEl.append(toastEl, panel, fab);
    document.body.appendChild(rootEl);
    updateUI();
}

async function handlePendingPrompt() {
    try {
        const res = await chrome.storage.local.get(['pendingPrompt']);
        const pending = res && res.pendingPrompt;
        if (!pending || typeof pending !== 'string' || pending.length === 0) return;
        await chrome.storage.local.remove(['pendingPrompt']);

        const trySet = async (attempts = 40) => {
            const input = findInput();
            if (input) { setInput(input, pending); return true; }
            if (attempts <= 0) return false;
            await sleep(500);
            return trySet(attempts - 1);
        };
        const ok = await trySet();
        if (ok) toast('🆕 Estado do projeto colado no campo. Envie quando quiser continuar.');
        else toast('⚠️ Não achei o campo para colar o estado automaticamente.');
    } catch { /* ignore */ }
}

async function bootstrap() {
    await loadToken();
    updateUI();
    connect();
    handlePendingPrompt();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { addUI(); bootstrap(); });
} else {
    addUI();
    bootstrap();
}
