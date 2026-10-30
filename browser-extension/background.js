// Service worker: mantém a conexão WebSocket com o VS Code.
// Só abre o socket DEPOIS de receber o token da aba (chrome.storage.local em content.js).
const WS_URL = 'ws://127.0.0.1:8765';

chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'vscode-bridge') return;

    const safePost = msg => { try { port.postMessage(msg); } catch { /* aba fechada */ } };
    let sock = null;
    let keepAlive = null;
    let token = '';
    let started = false;

    function openSocket() {
        if (started) return;
        started = true;

        let url = WS_URL;
        if (token) url += '?token=' + encodeURIComponent(token);

        try {
            sock = new WebSocket(url);
        } catch {
            safePost({ t: 'close' });
            return;
        }

        sock.onopen = () => {
            safePost({ t: 'open' });
            // Evita o service worker ser suspenso enquanto há conexão aberta
            keepAlive = setInterval(() => {
                if (sock.readyState === WebSocket.OPEN) sock.send('{"type":"ping"}');
            }, 20000);
        };
        sock.onmessage = e => safePost({ t: 'msg', data: e.data });
        sock.onerror = () => { /* onclose cuida do resto */ };
        sock.onclose = () => {
            clearInterval(keepAlive);
            safePost({ t: 'close' });
        };
    }

    port.onMessage.addListener(m => {
        if (!m) return;
        if (m.t === 'init') {
            token = typeof m.token === 'string' ? m.token : '';
            openSocket();
            return;
        }
        if (m.t === 'send' && sock && sock.readyState === WebSocket.OPEN) {
            sock.send(m.data);
        }
    });

    port.onDisconnect.addListener(() => {
        clearInterval(keepAlive);
        try { sock && sock.close(); } catch { /* ignore */ }
    });
});
