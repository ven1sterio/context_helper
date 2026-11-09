const test = require('node:test');
const assert = require('node:assert/strict');
const { MissionController } = require('../out/multiagent/missionController.js');
const { AgentRegistry } = require('../out/multiagent/agentRegistry.js');
const { DeliverableManager } = require('../out/multiagent/deliverableManager.js');
const { ReviewManager } = require('../out/multiagent/reviewManager.js');
const { SessionRouter } = require('../out/multiagent/sessionRouter.js');

function setup() {
    const registry = new AgentRegistry();
    const deliverables = new DeliverableManager();
    const reviews = new ReviewManager();
    const router = new SessionRouter();
    router.register('default', 'deepseek');
    const mc = new MissionController(registry, deliverables, reviews, router);
    return { mc, registry, deliverables, reviews, router };
}

test('start() cria plano com 7 tasks em fluxo base', () => {
    const { mc } = setup();
    const plan = mc.start({ title: 'T', objective: 'crie uma API de tarefas' });
    assert.equal(plan.tasks.length, 7);
    assert.equal(plan.tasks[0].role, 'analyst');
    assert.equal(plan.tasks[1].role, 'planner');
    assert.equal(plan.tasks[2].role, 'developer');
    assert.equal(plan.tasks[6].role, 'final_auditor');
});

test('dependências são lineares', () => {
    const { mc } = setup();
    const plan = mc.start({ title: 'T', objective: 'x' });
    assert.deepEqual(plan.tasks[0].dependsOn, []);
    assert.deepEqual(plan.tasks[1].dependsOn, [plan.tasks[0].taskId]);
    assert.deepEqual(plan.tasks[2].dependsOn, [plan.tasks[1].taskId]);
});

test('dispatchNext() devolve contrato da primeira task', () => {
    const { mc } = setup();
    mc.start({ title: 'T', objective: 'x' });
    const d = mc.dispatchNext('(contexto)');
    assert.ok(d);
    assert.equal(d.contract.role, 'analyst');
    assert.equal(d.contract.outputFormat, 'TEXT_ONLY');
    assert.match(d.prompt, /ANALYST|Analista|analis/i);
});

test('analista aceita só texto, sem review', () => {
    const { mc } = setup();
    mc.start({ title: 'T', objective: 'x' });
    const d = mc.dispatchNext('(ctx)');
    const res = mc.recordDelivery({
        taskId: d.contract.taskId,
        files: [],
        summary: 'Módulos: A, B. Riscos: nenhum.',
        buildPassed: false
    });
    assert.ok(res.accepted);
    assert.ok(!res.reviewPending);
});

test('planner também não passa por review', () => {
    const { mc } = setup();
    mc.start({ title: 'T', objective: 'x' });
    let d = mc.dispatchNext('(ctx)');
    mc.recordDelivery({ taskId: d.contract.taskId, files: [], summary: 'análise ok', buildPassed: false });
    d = mc.dispatchNext('(ctx)');
    assert.equal(d.contract.role, 'planner');
    const res = mc.recordDelivery({ taskId: d.contract.taskId, files: [], summary: 'plano ok', buildPassed: false });
    assert.ok(res.accepted);
    assert.ok(!res.reviewPending);
});

test('developer entra em awaiting_review', () => {
    const { mc } = setup();
    mc.start({ title: 'T', objective: 'x' });
    let d = mc.dispatchNext('(ctx)');
    mc.recordDelivery({ taskId: d.contract.taskId, files: [], summary: 'analise', buildPassed: false });
    d = mc.dispatchNext('(ctx)');
    mc.recordDelivery({ taskId: d.contract.taskId, files: [], summary: 'plano', buildPassed: false });
    d = mc.dispatchNext('(ctx)');
    assert.equal(d.contract.role, 'developer');
    const res = mc.recordDelivery({
        taskId: d.contract.taskId,
        files: ['src/a.js'],
        summary: 'implementado',
        buildPassed: true
    });
    assert.ok(res.accepted);
    assert.ok(res.reviewPending);
});

test('APROVADO aceita developer e tester juntos', () => {
    const { mc } = setup();
    mc.start({ title: 'T', objective: 'x' });
    let d = mc.dispatchNext('(ctx)');
    mc.recordDelivery({ taskId: d.contract.taskId, files: [], summary: 'a', buildPassed: false });
    d = mc.dispatchNext('(ctx)');
    mc.recordDelivery({ taskId: d.contract.taskId, files: [], summary: 'p', buildPassed: false });
    d = mc.dispatchNext('(ctx)');
    mc.recordDelivery({ taskId: d.contract.taskId, files: ['src/a.js'], summary: 'impl', buildPassed: true });
    d = mc.dispatchNext('(ctx)');
    assert.equal(d.contract.role, 'tester');
    mc.recordDelivery({ taskId: d.contract.taskId, files: ['test/a.test.js'], summary: 'testes', buildPassed: true });
    d = mc.dispatchNext('(ctx)');
    assert.equal(d.contract.role, 'reviewer');
    const res = mc.recordDelivery({
        taskId: d.contract.taskId,
        files: [],
        summary: 'APROVADO: código está bom.',
        buildPassed: true
    });
    assert.ok(res.accepted);
    const plan = mc.currentPlan;
    const dev = plan.tasks.find(t => t.role === 'developer');
    const test = plan.tasks.find(t => t.role === 'tester');
    assert.equal(dev.status, 'accepted');
    assert.equal(test.status, 'accepted');
});

test('REJEITADO marca developer como review_rejected', () => {
    const { mc } = setup();
    mc.start({ title: 'T', objective: 'x' });
    let d = mc.dispatchNext('(ctx)');
    mc.recordDelivery({ taskId: d.contract.taskId, files: [], summary: 'a', buildPassed: false });
    d = mc.dispatchNext('(ctx)');
    mc.recordDelivery({ taskId: d.contract.taskId, files: [], summary: 'p', buildPassed: false });
    d = mc.dispatchNext('(ctx)');
    mc.recordDelivery({ taskId: d.contract.taskId, files: ['src/a.js'], summary: 'impl', buildPassed: true });
    d = mc.dispatchNext('(ctx)');
    mc.recordDelivery({ taskId: d.contract.taskId, files: ['test/a.test.js'], summary: 'testes', buildPassed: true });
    d = mc.dispatchNext('(ctx)');
    const res = mc.recordDelivery({
        taskId: d.contract.taskId,
        files: [],
        summary: 'REJEITADO: falta tratamento de erro.',
        buildPassed: true
    });
    assert.ok(!res.accepted);
    const dev = mc.currentPlan.tasks.find(t => t.role === 'developer');
    assert.equal(dev.status, 'review_rejected');
});

test('complete() audita e marca failed se faltar build/review', () => {
    const { mc } = setup();
    mc.start({ title: 'T', objective: 'x' });
    const { audit } = mc.complete();
    assert.equal(audit.satisfied, false);
});

test('cancel() marca status cancelled', () => {
    const { mc } = setup();
    mc.start({ title: 'T', objective: 'x' });
    mc.cancel('teste');
    assert.equal(mc.currentPlan.status, 'cancelled');
});
