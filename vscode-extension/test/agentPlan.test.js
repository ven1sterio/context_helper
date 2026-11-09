const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { PlanManager } = require('../out/agent/planManager.js');
const { TaskQueue } = require('../out/agent/taskQueue.js');

function tmp() {
    return path.resolve(os.tmpdir(), 'ds-plan-' + Date.now() + '-' + Math.random().toString(36).slice(2));
}

test('create() com 1 tarefa padrão', () => {
    const pm = new PlanManager(tmp());
    const m = pm.create({ title: 'T', objective: 'fazer X' });
    assert.equal(m.tasks.length, 1);
    assert.equal(m.tasks[0].title, 'fazer X');
    assert.equal(m.status, 'pending');
    assert.equal(m.currentTaskId, null);
});

test('create() com N tarefas', () => {
    const pm = new PlanManager(tmp());
    const m = pm.create({
        title: 'T', objective: 'O',
        tasks: [
            { title: 'A' },
            { title: 'B', dependsOn: ['task-001'] },
            { title: 'C' }
        ]
    });
    assert.equal(m.tasks.length, 3);
    assert.equal(m.tasks[1].dependsOn[0], 'task-001');
});

test('nextTask() respeita dependsOn', () => {
    const pm = new PlanManager(tmp());
    pm.create({
        title: 'T', objective: 'O',
        tasks: [{ title: 'A' }, { title: 'B', dependsOn: ['task-001'] }]
    });
    let next = pm.nextTask();
    assert.equal(next.title, 'A');
    pm.setTaskStatus('task-001', 'completed');
    next = pm.nextTask();
    assert.equal(next.title, 'B');
});

test('setTaskStatus in_progress incrementa attempts e define currentTaskId', () => {
    const pm = new PlanManager(tmp());
    pm.create({ title: 'T', objective: 'O' });
    pm.setTaskStatus('task-001', 'in_progress');
    const m = pm.current;
    assert.equal(m.currentTaskId, 'task-001');
    assert.equal(m.tasks[0].attempts, 1);
    pm.setTaskStatus('task-001', 'in_progress');
    assert.equal(pm.current.tasks[0].attempts, 2);
});

test('completed limpa currentTaskId', () => {
    const pm = new PlanManager(tmp());
    pm.create({ title: 'T', objective: 'O' });
    pm.setTaskStatus('task-001', 'in_progress');
    pm.setTaskStatus('task-001', 'completed');
    assert.equal(pm.current.currentTaskId, null);
    assert.equal(pm.current.tasks[0].status, 'completed');
});

test('isMissionComplete só quando todas terminais', () => {
    const pm = new PlanManager(tmp());
    pm.create({ title: 'T', objective: 'O', tasks: [{ title: 'A' }, { title: 'B' }] });
    assert.equal(pm.isMissionComplete(), false);
    pm.setTaskStatus('task-001', 'completed');
    assert.equal(pm.isMissionComplete(), false);
    pm.setTaskStatus('task-002', 'completed');
    assert.equal(pm.isMissionComplete(), true);
});

test('flush/load faz round-trip', async () => {
    const root = tmp();
    const pm = new PlanManager(root);
    const m = pm.create({ title: 'T', objective: 'O' });
    await pm.flush();
    const pm2 = new PlanManager(root);
    const loaded = await pm2.load(m.id);
    assert.ok(loaded);
    assert.equal(loaded.title, 'T');
});

test('TaskQueue.snapshot()', () => {
    const pm = new PlanManager(tmp());
    pm.create({ title: 'T', objective: 'O', tasks: [{ title: 'A' }, { title: 'B' }] });
    pm.setTaskStatus('task-001', 'completed');
    pm.setTaskStatus('task-002', 'in_progress');
    const q = new TaskQueue(pm);
    const s = q.snapshot();
    assert.equal(s.completed, 1);
    assert.equal(s.inProgress, 1);
    assert.equal(s.currentTaskId, 'task-002');
});
