const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { PlanManager } = require('../../out/agent/planManager.js');
const { TaskQueue } = require('../../out/agent/taskQueue.js');
const { RunManager } = require('../../out/agent/runManager.js');
const { RunHistory } = require('../../out/agent/runHistory.js');
const { RecoveryManager } = require('../../out/agent/recoveryManager.js');

function tmp() {
    return path.resolve(os.tmpdir(), 'ds-int-full-' + Date.now() + '-' + Math.random().toString(36).slice(2));
}

test('Ciclo completo de Full Code (single agent)', async () => {
    const root = tmp();
    const plan = new PlanManager(root);
    const queue = new TaskQueue(plan);
    const history = new RunHistory(root);
    const recovery = new RecoveryManager(root);
    const rm = new RunManager(plan, queue, history, recovery);

    // 1) Inicia a missão
    const run = await rm.start('Missão de teste', 'criar um arquivo');
    assert.ok(run);
    assert.ok(fs.existsSync(recovery.fileOf()));

    // 2) Registra uma iteração bem-sucedida
    const advance = await rm.recordIteration({
        iteration: {
            index: 1,
            startedAt: new Date().toISOString(),
            appliedFiles: ['test.txt'],
            errors: [],
            status: 'applied',
            modelStatus: 'done'
        },
        modelStatus: 'done'
    });

    // 3) Deve ter concluído a missão com sucesso
    assert.equal(advance.action, 'done');
    assert.equal(advance.run.status, 'completed');

    // 4) current-run.json deve ter sido apagado
    assert.equal(fs.existsSync(recovery.fileOf()), false);

    // 5) O histórico deve ter a run registrada
    const hist = await history.list();
    assert.equal(hist.length, 1);
    assert.equal(hist[0].status, 'completed');
});
