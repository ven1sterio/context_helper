const test = require('node:test');
const assert = require('node:assert/strict');
const { DependencyAnalyzer } = require('../out/intelligence/dependencyAnalyzer.js');

const entry = (imports = []) => ({
    path: '', tokens: 10, sha1: '', imports,
    exports: [], symbols: [], summary: null, tags: []
});

function makeIndex(map) {
    const files = {};
    for (const [rel, imports] of Object.entries(map)) {
        files[rel] = { ...entry(imports), path: rel };
    }
    return { version: 2, workspaceRoot: '/', generatedAt: '', files };
}

test('direto: B importa A', () => {
    const idx = makeIndex({ 'a.js': [], 'b.js': ['a.js'] });
    const da = new DependencyAnalyzer(idx);
    assert.deepEqual(da.getDependencies('b.js'), ['a.js']);
    assert.deepEqual(da.getDependents('a.js'), ['b.js']);
});

test('ignora import de arquivo fora do projeto', () => {
    const idx = makeIndex({ 'a.js': ['react', 'lodash'] });
    const da = new DependencyAnalyzer(idx);
    assert.deepEqual(da.getDependencies('a.js'), []);
});

test('transitivo: C → B → A', () => {
    const idx = makeIndex({ 'a.js': [], 'b.js': ['a.js'], 'c.js': ['b.js'] });
    const da = new DependencyAnalyzer(idx);
    assert.deepEqual(da.getTransitiveDependencies('c.js', 2).sort(), ['a.js', 'b.js']);
    assert.deepEqual(da.getTransitiveDependents('a.js', 2).sort(), ['b.js', 'c.js']);
});

test('fanIn conta arquivos que dependem', () => {
    const idx = makeIndex({
        'a.js': [],
        'b.js': ['a.js'],
        'c.js': ['a.js'],
        'd.js': ['b.js']
    });
    const da = new DependencyAnalyzer(idx);
    assert.equal(da.fanIn('a.js', 3), 3);
});

test('detecta ciclo direto', () => {
    const idx = makeIndex({ 'a.js': ['b.js'], 'b.js': ['a.js'] });
    const da = new DependencyAnalyzer(idx);
    const cycles = da.detectCycles();
    assert.ok(cycles.length >= 1);
});

test('info() devolve dependências e dependentes', () => {
    const idx = makeIndex({ 'a.js': [], 'b.js': ['a.js'] });
    const da = new DependencyAnalyzer(idx);
    const i = da.info('a.js');
    assert.equal(i.file, 'a.js');
    assert.deepEqual(i.importedBy, ['b.js']);
    assert.equal(i.depthDown, 1);
});
