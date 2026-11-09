const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentRegistry } = require('../../out/multiagent/agentRegistry');
const { MissionController } = require('../../out/multiagent/missionController');
const { DeliverableManager } = require('../../out/multiagent/deliverableManager');
const { ReviewManager } = require('../../out/multiagent/reviewManager');
const { SessionRouter } = require('../../out/multiagent/sessionRouter');

test('Ciclo completo do Multiagente com rejeição e retry', () => {
    const registry = new AgentRegistry();
    const deliverables = new DeliverableManager();
    const reviews = new ReviewManager();
    const router = new SessionRouter();
    router.register('sess-1', 'deepseek');

    const controller = new MissionController(registry, deliverables, reviews, router);
    const mission = controller.start({ title: 'Teste', objective: 'Criar funcionalidade X' });

    // 1. Analyst
    let d1 = controller.dispatchNext('project content');
    assert.equal(d1.contract.role, 'analyst');
    let res1 = controller.recordDelivery({
        taskId: d1.contract.taskId,
        files: [],
        summary: 'Análise concluída',
        buildPassed: true
    });
    assert.ok(res1.accepted);

    // 2. Planner
    let d2 = controller.dispatchNext('project content');
    assert.equal(d2.contract.role, 'planner');
    let res2 = controller.recordDelivery({
        taskId: d2.contract.taskId,
        files: [],
        summary: 'Plano criado',
        buildPassed: true
    });
    assert.ok(res2.accepted);

    // 3. Developer
    let d3 = controller.dispatchNext('project content');
    assert.equal(d3.contract.role, 'developer');
    let res3 = controller.recordDelivery({
        taskId: d3.contract.taskId,
        files: ['src/feature.ts'],
        summary: 'Implementado',
        buildPassed: true
    });
    assert.ok(res3.accepted);

    // 4. Tester
    let d4 = controller.dispatchNext('project content');
    assert.equal(d4.contract.role, 'tester');
    let res4 = controller.recordDelivery({
        taskId: d4.contract.taskId,
        files: ['test/feature.test.ts'],
        summary: 'Testes criados',
        buildPassed: true
    });
    assert.ok(res4.accepted);

    // 5. Reviewer (rejeita na 1ª tentativa)
    let d5 = controller.dispatchNext('project content');
    assert.equal(d5.contract.role, 'reviewer');
    let res5 = controller.recordDelivery({
        taskId: d5.contract.taskId,
        files: [],
        summary: 'REJEITADO: Falta tratamento de erro',
        buildPassed: true
    });
    assert.equal(res5.accepted, false);

    // Retry do Developer
    let d3Retry = controller.dispatchNext('project content');
    assert.equal(d3Retry.contract.role, 'developer');
    controller.recordDelivery({
        taskId: d3Retry.contract.taskId,
        files: ['src/feature.ts'],
        summary: 'Implementado com correção',
        buildPassed: true
    });

    // Tester novamente
    let d4Retry = controller.dispatchNext('project content');
    assert.equal(d4Retry.contract.role, 'tester');
    controller.recordDelivery({
        taskId: d4Retry.contract.taskId,
        files: ['test/feature.test.ts'],
        summary: 'Testes atualizados',
        buildPassed: true
    });

    // Reviewer novamente (agora aprova)
    let d5Retry = controller.dispatchNext('project content');
    assert.equal(d5Retry.contract.role, 'reviewer');
    let res5Retry = controller.recordDelivery({
        taskId: d5Retry.contract.taskId,
        files: [],
        summary: 'APROVADO: Tudo correto',
        buildPassed: true
    });
    assert.ok(res5Retry.accepted);

    // 6. Integrator
    let d6 = controller.dispatchNext('project content');
    assert.equal(d6.contract.role, 'integrator');
    controller.recordDelivery({
        taskId: d6.contract.taskId,
        files: [],
        summary: 'Integrado',
        buildPassed: true
    });

    // 7. Final Auditor
    let d7 = controller.dispatchNext('project content');
    assert.equal(d7.contract.role, 'final_auditor');
    let finalRes = controller.recordDelivery({
        taskId: d7.contract.taskId,
        files: [],
        summary: 'CUMPRIDO: Objetivo atingido',
        buildPassed: true
    });
    assert.ok(finalRes.missionCompleted);
});
