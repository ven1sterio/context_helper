// Painel visual do agente. Sem lógica de negócio — só renderiza estado e
// chama callbacks. Toda a comunicação com o VS Code fica nos controllers.
(function () {
    'use strict';
    window.DS = window.DS || {};
    const state = window.DS.agentState;

    const STYLE = `
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
        .ds-close { position: absolute; top: 4px; right: 6px; background: transparent; border: none; color: #9aa0a6; font-size: 15px; cursor: pointer; padding: 0 4px; line-height: 1; }
        .ds-close:hover { color: #e8eaed; }
        .ds-row { display: flex; gap: 6px; align-items: center; }
        .ds-status { display: flex; align-items: center; gap: 6px; padding: 0 2px 4px; font-size: 11px; color: #9aa0a6; }
        .ds-status-dot { width: 6px; height: 6px; border-radius: 50%; background: #ea4335; flex-shrink: 0; }
        .ds-status.ds-connected .ds-status-dot { background: #34a853; }
        .ds-status.ds-running .ds-status-dot { background: #ff6d00; animation: ds-pulse 1.2s infinite; }
        @keyframes ds-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        .ds-btn {
            flex: 1; padding: 7px 10px; border: 1px solid transparent; border-radius: 8px;
            background: rgba(255, 255, 255, 0.06); color: #e8eaed; cursor: pointer;
            font-size: 12px; font-weight: 500; font-family: inherit; line-height: 1.2;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            transition: background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
        }
        .ds-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.12); }
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
        .ds-btn.ds-ghost:hover:not(:disabled) { color: #e8eaed; border-color: rgba(255, 255, 255, 0.22); }
        .ds-select { flex: 0 0 auto; padding: 7px 6px; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 8px; background: rgba(255, 255, 255, 0.06); color: #e8eaed; cursor: pointer; font-size: 11.5px; font-family: inherit; min-width: 80px; max-width: 92px; }
        .ds-sel { display: none; flex-direction: column; gap: 4px; padding-top: 6px; border-top: 1px solid rgba(255, 255, 255, 0.1); }
        .ds-sel.ds-visible { display: flex; }
        .ds-sel-header { font-size: 11px; color: #9aa0a6; padding: 2px 0; }
        .ds-sel-list { max-height: 320px; overflow-y: auto; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 6px; padding: 4px; background: rgba(0, 0, 0, 0.15); }
        .ds-sel-item { display: flex; gap: 6px; padding: 4px 6px; border-radius: 4px; font-size: 11px; cursor: pointer; align-items: flex-start; line-height: 1.3; }
        .ds-sel-item:hover { background: rgba(255, 255, 255, 0.06); }
        .ds-sel-item input { margin-top: 2px; flex-shrink: 0; }
        .ds-sel-body { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
        .ds-sel-name { color: #e8eaed; word-break: break-all; }
        .ds-sel-meta { color: #9aa0a6; font-size: 10px; word-break: break-word; }
        .ds-sel-actions { display: flex; gap: 6px; margin-top: 4px; }
        .ds-fab { width: 36px; height: 36px; border-radius: 50%; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(32, 33, 36, 0.92); color: #e8eaed; cursor: pointer; display: flex; align-items: center; justify-content: center; position: relative; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35); transition: transform 0.15s ease, background 0.15s ease; font-size: 16px; line-height: 1; padding: 0; }
        .ds-fab:hover { background: rgba(60, 64, 67, 0.95); transform: scale(1.06); }
        .ds-fab .ds-fab-dot { position: absolute; top: 2px; right: 2px; width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid rgba(32, 33, 36, 0.95); background: #ea4335; }
        .ds-fab.ds-connected .ds-fab-dot { background: #34a853; }
        .ds-fab .ds-fab-badge { position: absolute; bottom: -4px; right: -4px; background: #ff6d00; color: #fff; font-size: 9px; font-weight: 700; border-radius: 8px; padding: 1px 5px; min-width: 14px; text-align: center; line-height: 1.3; display: none; border: 1.5px solid rgba(32, 33, 36, 0.95); }
        .ds-fab.ds-busy .ds-fab-badge { display: block; }
        .ds-fab.ds-busy { animation: ds-pulse 1.6s ease-in-out infinite; }
    `;

    class Panel {
        constructor(opts) {
            this.opts = opts || {};
            this.expanded = false;
            this.fullCodeMode = false;
            this.instantMode = false;
            this.selectReview = false;
            this.selectionState = null;
            this._toastTimer = null;
            this._decompileProgress = null;
            this._decompileFailureTimer = null;
            this._decompileFailureCounts = null;
            this._els = {};
            this._build();
            state.subscribe(s => this.update(s));
            this.update({
                state: state.state, iteration: 0, connected: state.connected,
                missionId: null, runId: null, taskId: null, lastError: null
            });
        }

        _build() {
            // FIX BUG CRÍTICO: se o painel fosse reconstruído (content script
            // reinjetado), este guard só preenchia `_els.root` e `update()` logo
            // abaixo quebrava em `this._els.fab` (undefined). Remove tudo antes.
            const existingStyle = document.getElementById('ds-sync-styles');
            const existingRoot = document.getElementById('ds-sync-root');
            if (existingStyle) existingStyle.remove();
            if (existingRoot) existingRoot.remove();
            const style = document.createElement('style');
            style.id = 'ds-sync-styles';
            style.textContent = STYLE;
            document.head.appendChild(style);

            const root = document.createElement('div');
            root.id = 'ds-sync-root';

            const toast = document.createElement('div');
            toast.className = 'ds-toast';

            const panel = document.createElement('div');
            panel.className = 'ds-panel';

            const close = document.createElement('button');
            close.className = 'ds-close';
            close.textContent = '×';
            close.title = 'Fechar';
            close.onclick = () => this.togglePanel();

            const statusRow = document.createElement('div');
            statusRow.className = 'ds-status';
            const statusDot = document.createElement('span');
            statusDot.className = 'ds-status-dot';
            const statusLabel = document.createElement('span');
            statusLabel.textContent = (this.opts.siteName && this.opts.siteName()) || 'DeepSeek';
            statusRow.append(statusDot, statusLabel);

            // Row 1: toggles
            const r1 = document.createElement('div'); r1.className = 'ds-row';
            const fullCodeToggle = this._btn('🔁 Full Code', 'ds-ghost', () => {
                if (state.state === window.DS.STATES.RUNNING || state.state === window.DS.STATES.APPLYING) {
                    this.toast('Pare o agente antes de alternar.'); return;
                }
                this.fullCodeMode = !this.fullCodeMode;
                this.update(state && { state: state.state, connected: state.connected });
                this.toast(this.fullCodeMode ? '🔁 Full Code ATIVO.' : '⏹ Full Code desativado.');
            });
            const instantBtn = this._btn('⚡ Instantâneo', 'ds-ghost', () => {
                this.instantMode = !this.instantMode;
                window.DS.agent.setInstantMode(this.instantMode);
                try { chrome.storage.local.set({ instantMode: this.instantMode }); } catch { /* ignore */ }
                this.update(state && { state: state.state, connected: state.connected });
                this.toast(this.instantMode ? '⚡ Sem cooldown entre iterações.' : '🕒 Cooldown ativo.');
            });
            r1.append(fullCodeToggle, instantBtn);

            // Row 2: contexto + aplicar
            const r2 = document.createElement('div'); r2.className = 'ds-row';
            const fullBtn = this._btn('🔄 Contexto', 'ds-ghost', () => this.opts.onFullContext && this.opts.onFullContext());
            const applyBtn = this._btn('📥 Aplicar', 'ds-success', () => this.opts.onApply && this.opts.onApply());
            r2.append(fullBtn, applyBtn);

            // Row 3: seletivo + revisar + timeout
            const r3 = document.createElement('div'); r3.className = 'ds-row';
            const selectBtn = this._btn('🎯 Seletivo', 'ds-primary', () => this.opts.onSelect && this.opts.onSelect());
            const reviewBtn = this._btn('📋 Revisar', 'ds-ghost', () => {
                this.selectReview = !this.selectReview;
                try { chrome.storage.local.set({ selectReview: this.selectReview }); } catch { /* ignore */ }
                this.update(state && { state: state.state, connected: state.connected });
                this.toast(this.selectReview ? '📋 Vai mostrar a lista.' : '🎯 Cola direto.');
            });
            const timeoutSelect = document.createElement('select');
            timeoutSelect.className = 'ds-select';
            for (const v of [60, 300, 600]) {
                const opt = document.createElement('option');
                opt.value = String(v);
                opt.textContent = v === 60 ? '⏱ 1 min' : v === 300 ? '⏱ 5 min' : '⏱ 10 min';
                timeoutSelect.appendChild(opt);
            }
            timeoutSelect.onchange = () => {
                const v = Number(timeoutSelect.value);
                if (![60, 300, 600].includes(v)) return;
                this.opts.onSetTimeout && this.opts.onSetTimeout('agent', v);
                this.toast(`⏱ Timeout: ${v / 60} min.`);
            };
            r3.append(selectBtn, reviewBtn, timeoutSelect);

            // Row 4: anexar / rodar agente
            const r4 = document.createElement('div'); r4.className = 'ds-row';
            const attachBtn = this._btn('📎 Anexar contexto', 'ds-primary', () => {
                if (state.state === window.DS.STATES.RUNNING || state.state === window.DS.STATES.APPLYING) {
                    window.DS.agent.stop();
                } else if (this.fullCodeMode) {
                    window.DS.agent.start();
                } else {
                    this.opts.onAttach && this.opts.onAttach('auto');
                }
            });
            r4.append(attachBtn);

            // Row 5: esperar mais
            const rPause = document.createElement('div'); rPause.className = 'ds-row';
            const moreBtn = this._btn('⏱ Esperar mais', 'ds-warning', () => window.DS.agent.resolveWaitMore(true));
            moreBtn.style.display = 'none';
            rPause.append(moreBtn);

            // Seleção
            const selPanel = document.createElement('div'); selPanel.className = 'ds-sel';
            const selHeader = document.createElement('div'); selHeader.className = 'ds-sel-header';
            const selList = document.createElement('div'); selList.className = 'ds-sel-list';
            const selActions = document.createElement('div'); selActions.className = 'ds-sel-actions';
            const selApply = this._btn('✔ Aplicar', 'ds-success', () => this._applySelection());
            const selCancel = this._btn('✖ Cancelar', 'ds-ghost', () => { this.hideSelection(); this.toast('Cancelado.'); });
            selActions.append(selApply, selCancel);
            selPanel.append(selHeader, selList, selActions);

            // Row 5: nova conversa
            const r5 = document.createElement('div'); r5.className = 'ds-row';
            const newConvBtn = this._btn('🆕 Nova conversa', 'ds-ghost', () => this.opts.onNewConversation && this.opts.onNewConversation());
            r5.append(newConvBtn);

            // Row 6: token
            const r6 = document.createElement('div'); r6.className = 'ds-row';
            const tokenBtn = this._btn('🔑 Token', 'ds-ghost', () => this.opts.onPromptToken && this.opts.onPromptToken());
            r6.append(tokenBtn);

            panel.append(close, statusRow, r1, r2, r3, r4, rPause, selPanel, r5, r6);

            // FAB
            const fab = document.createElement('button');
            fab.className = 'ds-fab';
            fab.title = (this.opts.siteName && this.opts.siteName()) + ' Sync';
            const fabIcon = document.createElement('span');
            fabIcon.textContent = '🤖';
            const fabDot = document.createElement('span');
            fabDot.className = 'ds-fab-dot';
            const fabBadge = document.createElement('span');
            fabBadge.className = 'ds-fab-badge';
            fabBadge.textContent = '0';
            fab.append(fabIcon, fabDot, fabBadge);
            fab.onclick = () => this.togglePanel();

            root.append(toast, panel, fab);
            document.body.appendChild(root);

            this._els = {
                root, toast, panel,
                statusRow, statusDot, statusLabel,
                fullCodeToggle, instantBtn, fullBtn, applyBtn, selectBtn, reviewBtn, timeoutSelect,
                attachBtn, moreBtn, newConvBtn, tokenBtn,
                selPanel, selHeader, selList, selApply, selCancel,
                fab, fabIcon, fabDot, fabBadge
            };
        }

        _btn(label, cls, onClick) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'ds-btn ' + cls;
            b.textContent = label;
            b.onclick = onClick;
            return b;
        }

        togglePanel() {
            this.expanded = !this.expanded;
            this._els.panel.classList.toggle('ds-open', this.expanded);
            this.update(state && { state: state.state, connected: state.connected });
        }

        toast(text) {
            const el = this._els.toast;
            if (!el) return;
            el.textContent = text;
            el.classList.add('ds-visible');
            clearTimeout(this._toastTimer);
            this._toastTimer = setTimeout(() => el.classList.remove('ds-visible'), 6000);
        }

        refresh() { this.update({ state: state.state, connected: state.connected }); }

        showDecompileProgress(snap) {
            this._decompileProgress = snap || null;
            this.update(state && { state: state.state, connected: state.connected });
        }

        /**
         * Toast agregado para falhas de decompilação. Se 5 DLLs falharem por
         * "Ghidra encerrou com código 1", sai uma linha só ("5× Ghidra encerrou
         * com código 1"), em vez de 5 toasts que se sobrescrevem.
         */
        showDecompileFailure(failure) {
            if (!failure || !failure.rel) return;
            const key = (failure.kind || '?') + '|' +
                String(failure.reason || 'erro').split(/[.:\n]/)[0].trim().slice(0, 80);
            this._decompileFailureCounts = this._decompileFailureCounts || new Map();
            this._decompileFailureCounts.set(key, (this._decompileFailureCounts.get(key) || 0) + 1);

            clearTimeout(this._decompileFailureTimer);
            this._decompileFailureTimer = setTimeout(() => {
                const groups = [];
                for (const [k, n] of this._decompileFailureCounts.entries()) {
                    const reason = k.split('|')[1];
                    groups.push(n > 1 ? `${n}× ${reason}` : reason);
                }
                this._decompileFailureCounts.clear();
                const label = groups.length > 1 ? groups.join('; ') : groups[0];
                this.toast(`🔬 ${failure.kind === 'ghidra' ? 'Ghidra' : 'ILSpy'} falhou: ${label}. Abra o Output "DeepSeek Decompilação" no VS Code para detalhes.`);
            }, 1200);
        }

        update(s) {
            if (!this._els.fab) return;
            const st = s.state;
            const connected = s.connected;
            const running = st === window.DS.STATES.RUNNING || st === window.DS.STATES.STARTING;
            const applying = st === window.DS.STATES.APPLYING;
            const paused = st === window.DS.STATES.PAUSED;
            const busy = running || applying;

            this._els.fab.classList.toggle('ds-connected', connected);
            this._els.fab.classList.toggle('ds-busy', busy);
            this._els.fabIcon.textContent = busy ? '⏳' : (connected ? '🤖' : '⚠️');
            this._els.fabBadge.textContent = String(s.iteration || 0);

            this._els.statusRow.classList.toggle('ds-connected', connected);
            this._els.statusRow.classList.toggle('ds-running', busy);
            let statusText = !connected
                ? (window.DS.connection.authToken ? 'Desconectado' : 'Token não configurado')
                : paused ? `Pausado · iter. ${s.iteration}`
                : running ? `Rodando · iter. ${s.iteration}`
                : applying ? `Aplicando · iter. ${s.iteration}`
                : 'Conectado ao VS Code';
            const dp = this._decompileProgress;
            if (dp && dp.isWorking) {
                statusText += ` · 🔬 ${dp.running}/${dp.total}`;
            } else if (dp && dp.failed > 0 && dp.total > 0) {
                statusText += ` · 🔬 ${dp.done}/${dp.total} (${dp.failed} falhou)`;
            }
            this._els.statusLabel.textContent = statusText;

            this._els.fullCodeToggle.classList.toggle('ds-warning', this.fullCodeMode);
            this._els.fullCodeToggle.classList.toggle('ds-ghost', !this.fullCodeMode);
            this._els.fullCodeToggle.textContent = this.fullCodeMode ? '🔁 Full Code ✓' : '🔁 Full Code';

            this._els.instantBtn.classList.toggle('ds-warning', this.instantMode);
            this._els.instantBtn.classList.toggle('ds-ghost', !this.instantMode);
            this._els.instantBtn.textContent = this.instantMode ? '⚡ Instantâneo ✓' : '⚡ Instantâneo';

            this._els.reviewBtn.classList.toggle('ds-success', this.selectReview);
            this._els.reviewBtn.classList.toggle('ds-ghost', !this.selectReview);
            this._els.reviewBtn.textContent = this.selectReview ? '📋 Revisar ✓' : '📋 Revisar';

            this._els.attachBtn.classList.remove('ds-primary', 'ds-warning', 'ds-danger');
            if (busy) {
                this._els.attachBtn.textContent = `⏹ Parar (${s.iteration})`;
                this._els.attachBtn.classList.add('ds-danger');
            } else if (this.fullCodeMode) {
                this._els.attachBtn.textContent = '🚀 Rodar agente';
                this._els.attachBtn.classList.add('ds-warning');
            } else {
                this._els.attachBtn.textContent = window.DS.connection.nextIsDelta ? '📎 Anexar alterações' : '📎 Anexar contexto';
                this._els.attachBtn.classList.add('ds-primary');
            }

            this._els.applyBtn.disabled = busy || !connected;
            this._els.fullBtn.disabled = busy;
            this._els.selectBtn.disabled = !(!busy && !this.fullCodeMode && connected);
            this._els.newConvBtn.disabled = !connected;
            this._els.tokenBtn.classList.toggle('ds-ghost', !window.DS.connection.authToken);
            this._els.tokenBtn.classList.toggle('ds-success', !!window.DS.connection.authToken);
            this._els.tokenBtn.textContent = window.DS.connection.authToken ? '🔑 Token ✓' : '🔑 Token';
            this._els.moreBtn.style.display = paused ? '' : 'none';

            const v = String(window.DS.connection.timeouts.response);
            if (Array.from(this._els.timeoutSelect.options).some(o => o.value === v)) {
                this._els.timeoutSelect.value = v;
            }
        }

        showSelection(files, total, request) {
            this.selectionState = { files, total, request };
            const list = this._els.selList;
            list.textContent = '';
            for (const f of files) {
                const label = document.createElement('label');
                label.className = 'ds-sel-item';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = true;
                cb.dataset.path = f.path;
                cb.dataset.tokens = String(f.tokens || 0);
                cb.addEventListener('change', () => this._updateSelHeader());
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
                list.appendChild(label);
            }
            this._updateSelHeader();
            this._els.selPanel.classList.add('ds-visible');
            this._els.panel.classList.add('ds-selecting');
        }

        _updateSelHeader() {
            let checked = 0, tokens = 0, count = 0;
            for (const cb of this._els.selList.querySelectorAll('input[type="checkbox"]')) {
                count++;
                if (cb.checked) { checked++; tokens += Number(cb.dataset.tokens || 0); }
            }
            this._els.selHeader.textContent = `🎯 ${checked}/${count} arquivos · ~${(tokens / 1000).toFixed(1)}k tokens`;
            this._els.selApply.textContent = `✔ Aplicar (${checked}/${count})`;
            this._els.selApply.disabled = checked === 0;
        }

        async _applySelection() {
            const paths = [];
            for (const cb of this._els.selList.querySelectorAll('input[type="checkbox"]')) {
                if (cb.checked) paths.push(cb.dataset.path);
            }
            if (paths.length === 0) { this.toast('Selecione pelo menos um arquivo.'); return; }
            const question = (this.selectionState && this.selectionState.request) || '';
            this._els.selApply.disabled = true;
            this._els.selApply.textContent = '⏳ Montando...';
            try {
                await window.DS.context.buildAndPasteSelection(paths, question);
            } finally {
                this._els.selApply.disabled = false;
            }
        }

        hideSelection() {
            this.selectionState = null;
            if (this._els.selPanel) this._els.selPanel.classList.remove('ds-visible');
            if (this._els.selList) this._els.selList.textContent = '';
            if (this._els.selHeader) this._els.selHeader.textContent = '';
            if (this._els.panel) this._els.panel.classList.remove('ds-selecting');
        }
    }

    window.DS.Panel = Panel;
})();
