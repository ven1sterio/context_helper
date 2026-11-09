const test = require('node:test');
const assert = require('node:assert/strict');
const { ReviewManager } = require('../out/multiagent/reviewManager.js');
const { computeConsensus } = require('../out/multiagent/consensusManager.js');

test('sem reviews → consolidate retorna pending', () => {
    const r = new ReviewManager();
    assert.equal(r.consolidate('t1').status, 'pending');
});

test('uma review aprovada → approved', () => {
    const r = new ReviewManager();
    r.submit({ taskId: 't1', reviewerId: 'rev-1', verdict: 'approved', notes: 'ok' });
    const c = r.consolidate('t1');
    assert.equal(c.status, 'approved');
    assert.equal(c.notes.length, 1);
});

test('uma review rejeitada → rejected', () => {
    const r = new ReviewManager();
    r.submit({ taskId: 't1', reviewerId: 'rev-1', verdict: 'rejected', notes: 'falta x' });
    assert.equal(r.consolidate('t1').status, 'rejected');
});

test('duas rejeitadas → rejected com notas agregadas', () => {
    const r = new ReviewManager();
    r.submit({ taskId: 't1', reviewerId: 'rev-1', verdict: 'rejected', notes: 'a' });
    r.submit({ taskId: 't1', reviewerId: 'rev-2', verdict: 'rejected', notes: 'b' });
    const c = r.consolidate('t1');
    assert.equal(c.status, 'rejected');
    assert.equal(c.notes.length, 2);
});

test('consensus: 2 approved → approved', () => {
    const c = computeConsensus([
        { reviewId: 'r1', taskId: 't1', reviewerId: 'a', verdict: 'approved', notes: '', createdAt: '' },
        { reviewId: 'r2', taskId: 't1', reviewerId: 'b', verdict: 'approved', notes: '', createdAt: '' }
    ]);
    assert.equal(c.verdict, 'approved');
    assert.equal(c.votes.approved, 2);
});

test('consensus: 1 approved + 1 rejected → split', () => {
    const c = computeConsensus([
        { reviewId: 'r1', taskId: 't1', reviewerId: 'a', verdict: 'approved', notes: '', createdAt: '' },
        { reviewId: 'r2', taskId: 't1', reviewerId: 'b', verdict: 'rejected', notes: 'x', createdAt: '' }
    ]);
    assert.equal(c.verdict, 'split');
    assert.equal(c.divergences.length, 1);
});

test('needsReview: deliverable com requiresReview=true e sem review', () => {
    const r = new ReviewManager();
    const d = { taskId: 't1', requiresReview: true };
    assert.equal(r.needsReview(d), true);
});

test('needsReview: já tem review → false', () => {
    const r = new ReviewManager();
    r.submit({ taskId: 't1', reviewerId: 'x', verdict: 'approved', notes: 'ok' });
    const d = { taskId: 't1', requiresReview: true };
    assert.equal(r.needsReview(d), false);
});
