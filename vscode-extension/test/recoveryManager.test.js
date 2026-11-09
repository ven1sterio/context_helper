const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { RecoveryManager } = require('../out/agent/recoveryManager.js');

function tmp() {
    const d = path.resolve(os.tmpdir(), 'ds-rec-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    fs.mkdirSync(d, { recursive: true });
    return d;
}

const sampleRun = (over = {}) => ({
    id: 'run-x',
    missionId: 'mission-x',
    startedAt: '2026',
    iterations: [],
    status: 'running',
    ...over
});

test('sem arquivo → none', async () => {
    const rm = new RecoveryManager(tmp());
    const s = await rm.inspect();
    assert.equal(s.kind, 'none');
});

test('run completed → none', async () => {
    const root = tmp();
    const rm = new RecoveryManager(root);
    await rm.saveCurrentRun(sampleRun({ status: 'completed' }));
    const s = await rm.inspect();
    assert.equal(s.kind, 'none');
});

test('run running + arquivos existem → running', async () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'x');
    const rm = new RecoveryManager(root);
    await rm.saveCurrentRun(sampleRun({
        iterations: [{
            index: 1, startedAt: 'x', appliedFiles: ['src/a.js'],
            errors: [], status: 'applied'
        }]
    }));
    const s = await rm.inspect();
    assert.equal(s.kind, 'running');
});

test('run running + arquivo sumiu → stale', async () => {
    const root = tmp();
    const rm = new RecoveryManager(root);
    await rm.saveCurrentRun(sampleRun({
        iterations: [{
            index: 1, startedAt: 'x', appliedFiles: ['src/missing.js'],
            errors: [], status: 'applied'
        }]
    }));
    const s = await rm.inspect();
    assert.equal(s.kind, 'stale');
});

test('saveCurrentRun(null) apaga o arquivo', async () => {
    const root = tmp();
    const rm = new RecoveryManager(root);
    await rm.saveCurrentRun(sampleRun());
    assert.ok(fs.existsSync(rm.fileOf()));
    await rm.saveCurrentRun(null);
    assert.equal(fs.existsSync(rm.fileOf()), false);
});

test('inspect devolve mission quando disponível', async () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.deepseek-sync/agent/plans'), { recursive: true });
    fs.writeFileSync(
        path.join(root, '.deepseek-sync/agent/plans/mission-mission-x.json'),
        JSON.stringify({
            id: 'mission-x', title: 'T', objective: 'O',
            status: 'in_progress', createdAt: '2026', updatedAt: '2026',
            currentTaskId: 'task-001', tasks: []
        })
    );
    const rm = new RecoveryManager(root);
    await rm.saveCurrentRun(sampleRun());
    const s = await rm.inspect();
    assert.equal(s.kind, 'running');
    assert.ok(s.mission);
    assert.equal(s.mission.id, 'mission-x');
});
