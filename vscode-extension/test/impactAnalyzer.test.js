const test = require('node:test');
const assert = require('node:assert/strict');
const { DependencyAnalyzer } = require('../out/intelligence/dependencyAnalyzer.js');
const { ImpactAnalyzer } = require('../out/intelligence/impactAnalyzer.js');

const entry = (imports = []) => ({
    path: '', tokens: 10, sha1: '', imports,
    exports: [], symbols: [], summary: null, tags: []
});

function make(map) {
    const files = {};
    for (const [rel, imports] of Object.entries(map)) {
        files[rel] = { ...entry(imports), path: rel };
    }
    const idx = { version: 2, workspaceRoot: '/', generatedAt: '', files };
    return new ImpactAnalyzer(new DependencyAnalyzer(idx));
}

test('impacto direto', () => {
    const ia = make({ 'a.js': [], 'b.js': ['a.js'], 'c.js': ['a.js'] });
    const r = ia.analyze(['a.js']);
    assert.deepEqual(r.directlyImpacted.sort(), ['b.js', 'c.js']);
    assert.deepEqual(r.transitivelyImpacted, []);
});

test('impacto transitivo', () => {
    const ia = make({ 'a.js': [], 'b.js': ['a.js'], 'c.js': ['b.js'] });
    const r = ia.analyze(['a.js'], 2);
    assert.deepEqual(r.directlyImpacted, ['b.js']);
    assert.deepEqual(r.transitivelyImpacted, ['c.js']);
});

test('exclui arquivos alterados', () => {
    const ia = make({ 'a.js': [], 'b.js': ['a.js'] });
    const r = ia.analyze(['a.js', 'b.js']);
    assert.deepEqual(r.directlyImpacted, []);
});

test('múltiplos arquivos alterados', () => {
    const ia = make({
        'a.js': [], 'b.js': [], 'c.js': ['a.js'], 'd.js': ['b.js']
    });
    const r = ia.analyze(['a.js', 'b.js']);
    assert.deepEqual(r.directlyImpacted.sort(), ['c.js', 'd.js']);
});

test('sem impacto devolve vazio', () => {
    const ia = make({ 'a.js': [] });
    const r = ia.analyze(['a.js']);
    assert.equal(r.total, 0);
});
