// Identifica esta aba como uma sessão disponível para o multiagente.
// MVP: uma sessão por aba. Cada página do DeepSeek/Gemini/ChatGPT vira
// uma sessão registrada no VS Code.
(function () {
    'use strict';
    window.DS = window.DS || {};
    const conn = window.DS.connection;

    class SessionManager {
        constructor() {
            this.sessionId = null;
            this.provider = null;
            this.registered = false;
        }

        _detectProvider() {
            const host = location.hostname;
            if (host.includes('deepseek')) return 'deepseek';
            if (host.includes('gemini')) return 'gemini';
            if (host.includes('chatgpt') || host.includes('openai')) return 'chatgpt';
            return 'deepseek';
        }

        _generateId() {
            return 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
        }

        async _loadOrCreateId() {
            try {
                const r = await chrome.storage.local.get(['dsSessionId']);
                if (r && r.dsSessionId) return r.dsSessionId;
            } catch { /* ignore */ }
            const id = this._generateId();
            try { await chrome.storage.local.set({ dsSessionId: id }); } catch { /* ignore */ }
            return id;
        }

        async register() {
            if (this.registered) { this.reannounce(); return; }
            this.sessionId = await this._loadOrCreateId();
            this.provider = this._detectProvider();
            this._send();
            this.registered = true;
        }

        _send() {
            if (!conn.isOpen()) return;
            try {
                conn.ws.send(JSON.stringify({
                    type: 'registerSession',
                    sessionId: this.sessionId,
                    provider: this.provider
                }));
            } catch { /* ignore */ }
        }

        reannounce() {
            if (this.registered && conn.isOpen()) this._send();
        }

        markUnavailable() {
            if (!conn.isOpen() || !this.sessionId) return;
            try {
                conn.ws.send(JSON.stringify({
                    type: 'markSessionUnavailable',
                    sessionId: this.sessionId
                }));
            } catch { /* ignore */ }
        }
    }

    window.DS.session = new SessionManager();
})();
