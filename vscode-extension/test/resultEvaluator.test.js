const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../out/agent/resultEvaluator.js');

const it = (over = {}) => ({
    index: 1, startedAt: 'x', appliedFiles: ['a.js'],
    errors: [], status: 'applied', modelStatus: 'continue',
    ...over
});

test('guard tripado → stop', () => {
    const r = evaluate({
        iteration: it(),
        modelStatus: 'continue',
        guardTripped: true,
        guardReason: 'no-progress',
        missionComplete: false,
        hasNextTask: false
    });
    assert.equal(r.action, 'stop');
});

test('apply-failed → retry', () => {
    const r = evaluate({
        iteration: it({ status: 'apply-failed' }),
        modelStatus: 'continue',
        guardTripped: false,
        missionComplete: false,
        hasNextTask: false
    });
    assert.equal(r.action, 'retry');
});

test('no-files + continue → retry', () => {
    const r = evaluate({
        iteration: it({ status: 'no-files', appliedFiles: [] }),
        modelStatus: 'continue',
        guardTripped: false,
        missionComplete: false,
        hasNextTask: false
    });
    assert.equal(r.action, 'retry');
});

test('no-files + done → done', () => {
    const r = evaluate({
        iteration: it({ status: 'no-files', appliedFiles: [] }),
        modelStatus: 'done',
        guardTripped: false,
        missionComplete: false,
        hasNextTask: false
    });
    assert.equal(r.action, 'done');
});

test('applied-build-failed → retry', () => {
    const r = evaluate({
        iteration: it({ status: 'applied-build-failed' }),
        modelStatus: 'continue',
        guardTripped: false,
        missionComplete: false,
        hasNextTask: false
    });
    assert.equal(r.action, 'retry');
});

test('applied + continue → continue', () => {
    const r = evaluate({
        iteration: it(),
        modelStatus: 'continue',
        guardTripped: false,
        missionComplete: false,
        hasNextTask: false
    });
    assert.equal(r.action, 'continue');
});

test('applied + done + sem próxima tarefa → done', () => {
    const r = evaluate({
        iteration: it(),
        modelStatus: 'done',
        guardTripped: false,
        missionComplete: false,
        hasNextTask: false
    });
    assert.equal(r.action, 'done');
});

test('applied + done + próxima tarefa → continue', () => {
    const r = evaluate({
        iteration: it(),
        modelStatus: 'done',
        guardTripped: false,
        missionComplete: false,
        hasNextTask: true
    });
    assert.equal(r.action, 'continue');
});

test('applied + missionComplete → done', () => {
    const r = evaluate({
        iteration: it(),
        modelStatus: null,
        guardTripped: false,
        missionComplete: true,
        hasNextTask: false
    });
    assert.equal(r.action, 'done');
});
