const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentRegistry } = require('../out/multiagent/agentRegistry.js');

test('registry inicia com 8 agentes padrão', () => {
    const r = new AgentRegistry();
    assert.equal(r.list().length, 8);
});

test('firstForRole(developer) devolve developer-01', () => {
    const r = new AgentRegistry();
    const a = r.firstForRole('developer');
    assert.ok(a);
    assert.equal(a.agentId, 'developer-01');
});

test('role inexistente devolve null', () => {
    const r = new AgentRegistry();
    assert.equal(r.firstForRole('nonexistent'), null);
});

test('disable() remove do listByRole', () => {
    const r = new AgentRegistry();
    r.disable('developer-01');
    assert.equal(r.listByRole('developer').length, 0);
    assert.equal(r.firstForRole('developer'), null);
});

test('register() adiciona custom', () => {
    const r = new AgentRegistry();
    r.register({
        agentId: 'developer-02', role: 'developer', label: 'Dev 2',
        provider: 'gemini', enabled: true
    });
    assert.equal(r.listByRole('developer').length, 2);
});

test('replaceAll() substitui', () => {
    const r = new AgentRegistry();
    r.replaceAll([{ agentId: 'x', role: 'developer', label: 'X', provider: 'any', enabled: true }]);
    assert.equal(r.list().length, 1);
    assert.equal(r.list()[0].agentId, 'x');
});
