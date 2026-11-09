const test = require('node:test');
const assert = require('node:assert/strict');
const { validateMessage } = require('../out/security/messageValidator.js');

test('aceita ping', () => {
    const r = validateMessage({ type: 'ping' });
    assert.ok(r.ok);
});

test('aceita request sem mode', () => {
    const r = validateMessage({ type: 'request' });
    assert.ok(r.ok);
    assert.equal(r.message.mode, '');
});

test('aceita request com mode', () => {
    const r = validateMessage({ type: 'request', mode: 'auto' });
    assert.ok(r.ok);
    assert.equal(r.message.mode, 'auto');
});

test('rejeita mensagem não-objeto', () => {
    assert.equal(validateMessage(null).ok, false);
    assert.equal(validateMessage('oi').ok, false);
    assert.equal(validateMessage(42).ok, false);
});

test('rejeita sem type', () => {
    assert.equal(validateMessage({}).ok, false);
});

test('rejeita type desconhecido', () => {
    assert.equal(validateMessage({ type: 'xyz' }).ok, false);
});

test('applyFiles exige filePath', () => {
    const r = validateMessage({ type: 'applyFiles', files: [{ content: 'x' }] });
    assert.equal(r.ok, false);
});

test('applyFiles: EDIT exige search e replace', () => {
    const r = validateMessage({ type: 'applyFiles', files: [{ filePath: 'a.js', isEdit: true, search: 'x' }] });
    assert.equal(r.ok, false);
});

test('applyFiles: aceita FILE e EDIT', () => {
    const r = validateMessage({
        type: 'applyFiles',
        files: [
            { filePath: 'a.js', content: 'ok' },
            { filePath: 'b.js', isEdit: true, search: 'x', replace: 'y' }
        ]
    });
    assert.ok(r.ok);
    assert.equal(r.message.files.length, 2);
});

test('applyFiles: rejeita conteúdo grande demais', () => {
    const big = 'x'.repeat(500_001);
    const r = validateMessage({ type: 'applyFiles', files: [{ filePath: 'a', content: big }] });
    assert.equal(r.ok, false);
});

test('buildSelection exige paths', () => {
    assert.equal(validateMessage({ type: 'buildSelection' }).ok, false);
    assert.equal(validateMessage({ type: 'buildSelection', paths: ['a', 'b'] }).ok, true);
});

test('buildSelection: rejeita paths não-string', () => {
    assert.equal(validateMessage({ type: 'buildSelection', paths: ['a', 42] }).ok, false);
});

test('setTimeout valida which e value', () => {
    assert.equal(validateMessage({ type: 'setTimeout', which: 'xx', value: 60 }).ok, false);
    assert.equal(validateMessage({ type: 'setTimeout', which: 'response', value: -1 }).ok, false);
    assert.equal(validateMessage({ type: 'setTimeout', which: 'response', value: 99999 }).ok, false);
    assert.equal(validateMessage({ type: 'setTimeout', which: 'response', value: 300 }).ok, true);
});

test('updateState valida arrays', () => {
    assert.equal(validateMessage({ type: 'updateState', patch: { plan: ['a'], working: 'nao' } }).ok, false);
    assert.equal(validateMessage({ type: 'updateState', patch: { plan: ['a'], working: ['b'] } }).ok, true);
});

test('updateState rejeita objetivo gigante', () => {
    const big = 'a'.repeat(60_000);
    assert.equal(validateMessage({ type: 'updateState', patch: { objective: big } }).ok, false);
});
