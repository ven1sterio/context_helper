// WebSocket bridge + autenticação + correlação requisição/resposta.
// Inclui os eventos do multiagente (Fase 5).
(function () {
    'use strict';
    window.DS = window.DS || {};

    class BridgeSocket {
        constructor(token) {
            this.readyState = 0;
            this.onopen = null;
            this.onclose = null;
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
        send(data) {
            if (this.readyState === 1) this.port.postMessage({ t: 'send', data });
        }
        close() {
            try { this.port.disconnect(); } catch { /* ignore */ }
            this._finish();
        }
    }

    class ConnectionController {
        constructor() {
            this.ws = null;
            this.connected = false;
            this.authToken = '';
            this.reconnectTimer = null;
            this.lastConnErrorAt = 0;
            this.timeouts = { response: 600, run: 600, apply: 780 };
            this.nextIsDelta = false;

            this.waiting = null;
            this.waitingApplyResult = null;
            this.waitingSelection = null;
            this.waitingState = null;
            this.waitingMissionStart = null;
            this.waitingRE = null;

            this.reconnectAttempts = 0;

            this._handlers = {};
        }

        on(type, fn) { this._handlers[type] = fn; }
        _notify(type, payload) {
            const fn = this._handlers[type];
            if (fn) try { fn(payload); } catch { /* ignore */ }
        }

        async loadToken() {
            try {
                const r = await chrome.storage.local.get(['vscodeToken']);
                this.authToken = (r && r.vscodeToken) || '';
            } catch { this.authToken = ''; }
        }

        async saveToken(t) {
            this.authToken = (t || '').trim();
            try {
                if (this.authToken) await chrome.storage.local.set({ vscodeToken: this.authToken });
                else await chrome.storage.local.remove('vscodeToken');
            } catch { /* ignore */ }
        }

        isOpen() { return this.connected && this.ws && this.ws.readyState === 1; }

        connect() {
            try { this.ws = new BridgeSocket(this.authToken); }
            catch (e) {
                // Antes era um catch silencioso: se o SW não aceitasse o port,
                // o usuário só via "Desconectado" para sempre sem saber por quê.
                if (window.DS && window.DS.log) {
                    window.DS.log.warn('connection',
                        'falha ao criar BridgeSocket: ' + (e && e.message ? e.message : e));
                }
                this.scheduleReconnect();
                return;
            }

            this.ws.onopen = () => {
                this.connected = true;
                this.nextIsDelta = false;
                this.reconnectAttempts = 0;
                this._notify('open');
            };

            this.ws.onclose = () => {
                this.connected = false;
                this._notify('close');
                this._cancelAllWaiters('Conexão com o VS Code foi fechada.');
                const now = Date.now();
                if (now - this.lastConnErrorAt > 30000 && !this.authToken) {
                    this.lastConnErrorAt = now;
                    this._notify('no-token');
                }
                this.scheduleReconnect();
            };

            this.ws.onmessage = (event) => {
                let msg;
                try { msg = JSON.parse(event.data); } catch { return; }
                this._handleMessage(msg);
            };
        }

        _handleMessage(msg) {
            const t = msg.type;
            if (t === 'config' && msg.timeouts) {
                this.timeouts = { ...this.timeouts, ...msg.timeouts };
                this._notify('config', this.timeouts);
            } else if (t === 'context') {
                this._finish('waiting', msg);
            } else if (t === 'applyResult') {
                this._finish('waitingApplyResult', msg);
                this._notify('applyResult', msg);
            } else if (t === 'selection' || t === 'selectionContext') {
                this._finish('waitingSelection', msg);
            } else if (t === 'state') {
                this._finish('waitingState', msg);
            } else if (t === 'missionStarted') {
                this._finish('waitingMissionStart', msg);
            } else if (t === 'reResult') {
                this._finish('waitingRE', msg);
            } else if (t === 'aborted') {
                // ignore
            } else if (t === 'error') {
                this._notify('error', msg);
            } else if (t === 'stateUpdated') {
                this._notify('stateUpdated', msg);
            } else if (t === 'runCancelled') {
                this._notify('runCancelled', msg);
            } else if (t === 'runState') {
                this._notify('runState', msg);
            } else if (t === 'nextTaskDispatch') {
                this._notify('nextTaskDispatch', msg);
            } else if (t === 'multiAgentMissionStarted') {
                this._notify('multiAgentMissionStarted', msg);
            } else if (t === 'deliverableRecorded') {
                this._notify('deliverableRecorded', msg);
            } else if (t === 'multiAgentMissionCompleted') {
                this._notify('multiAgentMissionCompleted', msg);
            } else if (t === 'multiAgentMissionCancelled') {
                this._notify('multiAgentMissionCancelled', msg);
            } else if (t === 'multiAgentError') {
                this._notify('multiAgentError', msg);
            } else if (t === 'multiAgentState') {
                this._notify('multiAgentState', msg);
            } else if (t === 'sessionRegistered') {
                this._notify('sessionRegistered', msg);
            }
        }

        _finish(prop, msg) {
            const w = this[prop];
            if (!w) return;
            clearTimeout(w.timer);
            this[prop] = null;
            try { w.resolve(msg); } catch { /* ignore */ }
        }

        _cancelAllWaiters(reason) {
            const props = ['waiting', 'waitingApplyResult', 'waitingSelection', 'waitingState', 'waitingMissionStart', 'waitingRE'];
            for (const p of props) {
                if (this[p]) {
                    const w = this[p];
                    clearTimeout(w.timer);
                    this[p] = null;
                    try { w.resolve({ error: reason, status: 'error' }); } catch { /* ignore */ }
                }
            }
        }

        scheduleReconnect() {
            clearTimeout(this.reconnectTimer);
            // Backoff exponencial (3s, 6s, 12s, 24s, teto 30s). Antes era 3s
            // fixo: se o VS Code ficasse desligado por horas, o content script
            // martelava a porta 8765 a cada 3s — gasto de CPU/bateria sem
            // retorno. Agora converge para 30s e reseta no primeiro open.
            const delay = Math.min(30000, 3000 * Math.pow(2, this.reconnectAttempts || 0));
            this.reconnectAttempts = Math.min((this.reconnectAttempts || 0) + 1, 10);
            this.reconnectTimer = setTimeout(() => this.connect(), delay);
        }

        requestContext(mode) {
            return new Promise((resolve) => {
                if (!this.isOpen() || this.waiting) { resolve(null); return; }
                const timer = setTimeout(() => this._finish('waiting', null), 5000);
                this.waiting = { resolve, timer };
                this.ws.send(JSON.stringify({ type: 'request', mode }));
            });
        }

        requestSelection(type, payload) {
            return new Promise((resolve) => {
                if (!this.isOpen()) { resolve({ error: 'Sem conexão com o VS Code.' }); return; }
                if (this.waitingSelection) { resolve({ error: 'Já existe uma seleção em andamento.' }); return; }
                const timer = setTimeout(
                    () => this._finish('waitingSelection', { error: 'Timeout aguardando o VS Code.' }),
                    30000
                );
                this.waitingSelection = { resolve, timer };
                this.ws.send(JSON.stringify({ type, ...payload }));
            });
        }

        requestState() {
            return new Promise((resolve) => {
                if (!this.isOpen()) { resolve({ state: '' }); return; }
                if (this.waitingState) { resolve({ state: '' }); return; }
                const timer = setTimeout(() => this._finish('waitingState', { state: '' }), 5000);
                this.waitingState = { resolve, timer };
                this.ws.send(JSON.stringify({ type: 'getState' }));
            });
        }

        startMission(title, objective) {
            return new Promise((resolve) => {
                if (!this.isOpen()) { resolve(null); return; }
                if (this.waitingMissionStart) { resolve(null); return; }
                const timer = setTimeout(() => this._finish('waitingMissionStart', { error: 'Timeout startMission.' }), 10000);
                this.waitingMissionStart = { resolve, timer };
                this.ws.send(JSON.stringify({ type: 'startMission', title, objective }));
            });
        }

        applyFiles(files, opts = {}) {
            return new Promise((resolve) => {
                if (!this.isOpen()) { resolve(null); return; }
                if (this.waitingApplyResult) { resolve(null); return; }
                const timer = setTimeout(
                    () => this._finish('waitingApplyResult', { status: 'error', message: 'Timeout aguardando apply+run.' }),
                    this.timeouts.apply * 1000
                );
                this.waitingApplyResult = { resolve, timer };
                this.ws.send(JSON.stringify({
                    type: 'applyFiles',
                    files,
                    autoApply: true,
                    runAfter: true,
                    missionId: opts.missionId,
                    runId: opts.runId,
                    modelStatus: opts.modelStatus || null
                }));
            });
        }

        applyFilesManual(files) {
            return new Promise((resolve) => {
                if (!this.isOpen()) { resolve(null); return; }
                if (this.waitingApplyResult) { resolve(null); return; }
                const timer = setTimeout(
                    () => this._finish('waitingApplyResult', { status: 'error', message: 'Timeout.' }),
                    this.timeouts.apply * 1000
                );
                this.waitingApplyResult = { resolve, timer };
                this.ws.send(JSON.stringify({ type: 'applyFiles', files }));
            });
        }

        /** Envia pedidos de engenharia reversa ao VS Code e espera o texto de resultado. */
        requestRE(requests) {
            return new Promise((resolve) => {
                if (!this.isOpen()) { resolve({ ok: false, text: 'Sem conexão com o VS Code.' }); return; }
                if (this.waitingRE) { resolve({ ok: false, text: 'Já existe um pedido RE em andamento.' }); return; }
                // A 1ª análise de uma DLL grande no Ghidra pode levar dezenas de minutos.
                const timer = setTimeout(
                    () => this._finish('waitingRE', { ok: false, text: 'Timeout aguardando a engenharia reversa (a análise pode ainda estar rodando no VS Code; repita o pedido depois).' }),
                    40 * 60 * 1000
                );
                this.waitingRE = { resolve, timer };
                this.ws.send(JSON.stringify({ type: 'reRequest', requests }));
            });
        }

        abort() {
            try { if (this.isOpen()) this.ws.send(JSON.stringify({ type: 'abort' })); } catch { /* ignore */ }
        }

        cancelRun(reason) {
            try { if (this.isOpen()) this.ws.send(JSON.stringify({ type: 'cancelRun', reason })); } catch { /* ignore */ }
        }

        setTimeoutSeconds(which, value) {
            try { if (this.isOpen()) this.ws.send(JSON.stringify({ type: 'setTimeout', which, value })); } catch { /* ignore */ }
        }

        updateState(patch) {
            try { if (this.isOpen()) this.ws.send(JSON.stringify({ type: 'updateState', patch })); } catch { /* ignore */ }
        }
    }

    window.DS.BridgeSocket = BridgeSocket;
    window.DS.connection = new ConnectionController();
})();
