// Testa as constantes e utilitários do core/protocol.js (executado em vm).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BE = path.join(__dirname, '..', '..', 'browser-extension');

function loadProtocol() {
    const sandbox = { window: {}, setTimeout, clearTimeout, Promise };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(BE, 'core', 'protocol.js'), 'utf8'), sandbox);
    return sandbox.window.DS.protocol;
}

test('WS_URL aponta para 127.0.0.1:8765', () => {
    const p = loadProtocol();
    assert.equal(p.WS_URL, 'ws://127.0.0.1:8765');
});

test('MAX_AGENT_ITERATIONS é 40', () => {
    const p = loadProtocol();
    assert.equal(p.MAX_AGENT_ITERATIONS, 40);
});

test('MAX_CONSECUTIVE_FAILURES é 6', () => {
    const p = loadProtocol();
    assert.equal(p.MAX_CONSECUTIVE_FAILURES, 6);
});

test('SUGGEST_NEW_CHAT_AFTER é 20', () => {
    const p = loadProtocol();
    assert.equal(p.SUGGEST_NEW_CHAT_AFTER, 20);
});

test('HUMAN_DELAY tem todas as chaves esperadas', () => {
    const p = loadProtocol();
    const keys = ['warmup', 'beforeSend', 'afterSend', 'betweenContinue',
        'afterFailure', 'afterSendFailed', 'betweenResends', 'maxContinueClicks'];
    for (const k of keys) assert.ok(k in p.HUMAN_DELAY, `falta ${k}`);
});

test('HUMAN_DELAY: cada par tem [min, max] válidos', () => {
    const p = loadProtocol();
    for (const k of ['warmup', 'beforeSend', 'afterSend', 'betweenContinue',
        'afterFailure', 'afterSendFailed', 'betweenResends']) {
        const [min, max] = p.HUMAN_DELAY[k];
        assert.ok(Number.isFinite(min) && min >= 0, `${k} min inválido`);
        assert.ok(Number.isFinite(max) && max >= min, `${k} max inválido`);
    }
});

test('sleep() resolve depois do tempo', async () => {
    const p = loadProtocol();
    const start = Date.now();
    await p.sleep(30);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 25, `elapsed=${elapsed}`);
});
