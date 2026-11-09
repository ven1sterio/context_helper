const test = require('node:test');
const assert = require('node:assert/strict');
const { auditMission } = require('../out/multiagent/finalAuditor.js');

const crit = (id, check) => ({ id, description: id, check });

test('sem build, sem review → não satisfeito', () => {
    const r = auditMission(
        [{ taskId: 't1', status: 'accepted' }],
        [], [],
        [crit('c1', 'build'), crit('c2', 'review'), crit('c3', 'audit')],
        false
    );
    assert.equal(r.satisfied, false);
});

test('todas as conditions OK → satisfeito', () => {
    const r = auditMission(
        [{ taskId: 't1', status: 'accepted' }],
        [{ deliverableId: 'd1', taskId: 't1' }],
        [{ reviewId: 'r1', taskId: 't1', verdict: 'approved' }],
        [crit('c1', 'build'), crit('c2', 'review'), crit('c3', 'audit')],
        true
    );
    assert.equal(r.satisfied, true);
});

test('task pendente → missing', () => {
    const r = auditMission(
        [{ taskId: 't1', status: 'accepted' }, { taskId: 't2', status: 'pending' }],
        [], [],
        [crit('c1', 'build')],
        true
    );
    assert.ok(r.missingTasks.includes('t2'));
    assert.equal(r.satisfied, false);
});

test('task failed → rejectedTasks', () => {
    const r = auditMission(
        [{ taskId: 't1', status: 'failed' }],
        [], [],
        [crit('c1', 'build')],
        true
    );
    assert.ok(r.rejectedTasks.includes('t1'));
});

test('perCriterion detalha cada check', () => {
    const r = auditMission(
        [{ taskId: 't1', status: 'accepted' }],
        [], [{ reviewId: 'r1', taskId: 't1', verdict: 'approved' }],
        [crit('c1', 'build'), crit('c2', 'review'), crit('c3', 'audit')],
        true
    );
    assert.equal(r.perCriterion.length, 3);
    const build = r.perCriterion.find(p => p.criterion.check === 'build');
    const review = r.perCriterion.find(p => p.criterion.check === 'review');
    const audit = r.perCriterion.find(p => p.criterion.check === 'audit');
    assert.ok(build.satisfied);
    assert.ok(review.satisfied);
    assert.ok(audit.satisfied);
});
