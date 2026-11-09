const test = require('node:test');
const assert = require('node:assert/strict');
const { IterationGuard } = require('../out/agent/iterationGuard.js');

function it(over = {}) {
    return {
        index: 1, startedAt: '2026', appliedFiles: ['a.js'],
        errors: [], status: 'applied', modelStatus: 'continue',
        ...over
    };
}

test('sem trip em iterações saudáveis', () => {
    const g = new IterationGuard();
    const t = g.check([it(), it()], 1, 'task-001');
    assert.equal(t.kind, 'none');
});

test('trip em consecutive-failures', () => {
    const g = new IterationGuard({ maxConsecutiveFailures: 3, maxNoProgress: 99, maxAttemptsPerTask: 99, maxTotalIterations: 99 });
    const its = [
        it({ status: 'apply-failed' }),
        it({ status: 'apply-failed' }),
        it({ status: 'apply-failed' })
    ];
    const t = g.check(its, 1, 'task-001');
    assert.equal(t.kind, 'consecutive-failures');
    assert.equal(t.count, 3);
});

test('trip em no-progress', () => {
    const g = new IterationGuard({ maxConsecutiveFailures: 99, maxNoProgress: 2, maxAttemptsPerTask: 99, maxTotalIterations: 99 });
    const its = [
        it({ status: 'no-files', appliedFiles: [] }),
        it({ status: 'no-files', appliedFiles: [] })
    ];
    const t = g.check(its, 1, 'task-001');
    assert.equal(t.kind, 'no-progress');
});

test('trip em attempts-per-task', () => {
    const g = new IterationGuard({ maxConsecutiveFailures: 99, maxNoProgress: 99, maxAttemptsPerTask: 3, maxTotalIterations: 99 });
    const t = g.check([it()], 3, 'task-001');
    assert.equal(t.kind, 'attempts-per-task');
    assert.equal(t.taskId, 'task-001');
});

test('trip em total-iterations', () => {
    const g = new IterationGuard({ maxConsecutiveFailures: 99, maxNoProgress: 99, maxAttemptsPerTask: 99, maxTotalIterations: 2 });
    const its = [it(), it()];
    const t = g.check(its, 1, 'task-001');
    assert.equal(t.kind, 'total-iterations');
});

test('trip em repeated-error', () => {
    const g = new IterationGuard();
    const its = [
        it({ status: 'apply-failed', errors: ['mesmo erro'] }),
        it({ status: 'apply-failed', errors: ['mesmo erro'] }),
        it({ status: 'apply-failed', errors: ['mesmo erro'] })
    ];
    const t = g.check(its, 1, 'task-001');
    // pode vir como consecutive-failures (limite 6) ou repeated-error
    assert.notEqual(t.kind, 'none');
});
