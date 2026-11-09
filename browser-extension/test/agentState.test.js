// Testa a máquina de estado do agente (core/agentState.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BE = path.join(__dirname, '..', '..', 'browser-extension');

function loadAgentState() {
    const sandbox = { window: {}, console: { warn: () => {}, log: () => {} } };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(BE, 'core', 'agentState.js'), 'utf8'), sandbox);
    return sandbox.window.DS;
}

test('estado inicial é IDLE', () => {
    const DS = loadAgentState();
    assert.equal(DS.agentState.state, DS.STATES.IDLE);
    assert.equal(DS.agentState.connected, false);
});

test('setConnected(true) transiciona IDLE → CONNECTED', () => {
    const DS = loadAgentState();
    DS.agentState.setConnected(true);
    assert.equal(DS.agentState.state, DS.STATES.CONNECTED);
    assert.equal(DS.agentState.connected, true);
});

test('setConnected(false) volta a IDLE', () => {
    const DS = loadAgentState();
    DS.agentState.setConnected(true);
    DS.agentState.setConnected(false);
    assert.equal(DS.agentState.state, DS.STATES.IDLE);
});

test('subscribe recebe eventos', () => {
    const DS = loadAgentState();
    let fired = 0;
    let last = null;
    DS.agentState.subscribe((s) => { fired++; last = s; });
    DS.agentState.setConnected(true);
    assert.ok(fired >= 1);
    assert.equal(last.connected, true);
});

test('transition(STARTING) funciona a partir de CONNECTED', () => {
    const DS = loadAgentState();
    DS.agentState.setConnected(true);
    DS.agentState.transition(DS.STATES.STARTING, { iteration: 1 });
    assert.equal(DS.agentState.state, DS.STATES.STARTING);
    assert.equal(DS.agentState.iteration, 1);
});

test('transition(RUNNING) e depois DONE', () => {
    const DS = loadAgentState();
    DS.agentState.setConnected(true);
    DS.agentState.transition(DS.STATES.STARTING);
    DS.agentState.transition(DS.STATES.RUNNING);
    DS.agentState.transition(DS.STATES.DONE);
    assert.equal(DS.agentState.state, DS.STATES.DONE);
});

test('patch de missionId/runId fica acessível', () => {
    const DS = loadAgentState();
    DS.agentState.transition(DS.STATES.STARTING, {
        missionId: 'm-1', runId: 'r-1'
    });
    assert.equal(DS.agentState.missionId, 'm-1');
    assert.equal(DS.agentState.runId, 'r-1');
});

test('reset() volta ao estado conectado', () => {
    const DS = loadAgentState();
    DS.agentState.setConnected(true);
    DS.agentState.transition(DS.STATES.RUNNING, { iteration: 5 });
    DS.agentState.reset();
    assert.equal(DS.agentState.state, DS.STATES.CONNECTED);
    assert.equal(DS.agentState.iteration, 0);
    assert.equal(DS.agentState.missionId, null);
});

test('unsubscribe() funciona', () => {
    const DS = loadAgentState();
    let fired = 0;
    const unsub = DS.agentState.subscribe(() => { fired++; });
    DS.agentState.setConnected(true);
    const before = fired;
    unsub();
    DS.agentState.setConnected(false);
    assert.equal(fired, before);
});

test('transição inválida emite warning mas não quebra', () => {
    const DS = loadAgentState();
    // IDLE → DONE não está em TRANSITIONS.idle
    const warn = { count: 0 };
    // substitui console.warn temporariamente
    // (recarrega com warn interceptado)
    const sandbox = { window: {}, console: { warn: () => warn.count++, log: () => {} } };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(BE, 'core', 'agentState.js'), 'utf8'), sandbox);
    sandbox.window.DS.agentState.transition(sandbox.window.DS.STATES.DONE);
    assert.equal(sandbox.window.DS.agentState.state, sandbox.window.DS.STATES.DONE);
    assert.ok(warn.count >= 1, 'warning esperado');
});
