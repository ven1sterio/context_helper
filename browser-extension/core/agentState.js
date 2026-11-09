// Máquina de estado do agente no navegador. Emite eventos para a UI.
// Carregado cedo — protocol usa.
(function () {
    'use strict';
    window.DS = window.DS || {};

    const STATES = Object.freeze({
        IDLE: 'idle',           // sem conexão ou nada acontecendo
        CONNECTED: 'connected', // conectado, ocioso
        STARTING: 'starting',   // agente iniciando
        RUNNING: 'running',     // agente executando
        PAUSED: 'paused',       // aguardando "Esperar mais"
        APPLYING: 'applying',   // aplicando/executando build
        DONE: 'done',           // concluído com sucesso
        ERROR: 'error'          // erro fatal
    });

    const TRANSITIONS = {
        idle: ['connected', 'error', 'starting'],
        connected: ['idle', 'starting', 'error'],
        starting: ['running', 'error', 'idle'],
        running: ['applying', 'paused', 'done', 'error', 'idle'],
        paused: ['running', 'idle', 'error'],
        applying: ['running', 'paused', 'done', 'error', 'idle'],
        done: ['idle', 'starting', 'connected'],
        error: ['idle', 'connected', 'starting']
    };

    class AgentState {
        constructor() {
            this._state = STATES.IDLE;
            this._iteration = 0;
            this._missionId = null;
            this._runId = null;
            this._taskId = null;
            this._connected = false;
            this._lastError = null;
            this._listeners = new Set();
        }

        get state() { return this._state; }
        get iteration() { return this._iteration; }
        get missionId() { return this._missionId; }
        get runId() { return this._runId; }
        get taskId() { return this._taskId; }
        get connected() { return this._connected; }
        get lastError() { return this._lastError; }

        subscribe(fn) {
            this._listeners.add(fn);
            return () => this._listeners.delete(fn);
        }

        setConnected(v) {
            this._connected = !!v;
            if (!v && this._state !== STATES.IDLE) {
                this._transition(STATES.IDLE);
            } else if (v && this._state === STATES.IDLE) {
                this._transition(STATES.CONNECTED);
            } else {
                this._emit();
            }
        }

        transition(to, patch = {}) {
            if (to === this._state && Object.keys(patch).length === 0) return;
            const allowed = TRANSITIONS[this._state] || [];
            if (to !== this._state && !allowed.includes(to)) {
                console.warn(`[DS] transição não usual: ${this._state} → ${to}`);
            }
            if (patch.iteration !== undefined) this._iteration = patch.iteration;
            if (patch.missionId !== undefined) this._missionId = patch.missionId;
            if (patch.runId !== undefined) this._runId = patch.runId;
            if (patch.taskId !== undefined) this._taskId = patch.taskId;
            if (patch.lastError !== undefined) this._lastError = patch.lastError;
            this._transition(to);
        }

        _transition(to) {
            const from = this._state;
            this._state = to;
            this._emit({ from, to });
        }

        _emit(extra) {
            const detail = {
                state: this._state,
                iteration: this._iteration,
                missionId: this._missionId,
                runId: this._runId,
                taskId: this._taskId,
                connected: this._connected,
                lastError: this._lastError,
                ...(extra || {})
            };
            for (const fn of this._listeners) {
                try { fn(detail); } catch { /* ignore */ }
            }
        }

        reset() {
            this._iteration = 0;
            this._missionId = null;
            this._runId = null;
            this._taskId = null;
            this._lastError = null;
            this._transition(this._connected ? STATES.CONNECTED : STATES.IDLE);
        }
    }

    window.DS.STATES = STATES;
    window.DS.AgentState = AgentState;
    window.DS.agentState = new AgentState();
})();
