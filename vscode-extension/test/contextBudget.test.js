const test = require('node:test');
const assert = require('node:assert/strict');
const { ContextBudget } = require('../out/intelligence/contextBudget.js');

function make(map) {
    const files = {};
    for (const [rel, tokens] of Object.entries(map)) {
        files[rel] = {
            path: rel, tokens, sha1: '', imports: [],
            exports: [], symbols: [], summary: null, tags: []
        };
    }
    return { version: 2, workspaceRoot: '/', generatedAt: '', files };
}

test('entry point vem antes de arquivo qualquer', () => {
    const idx = make({
        'src/index.ts': 1000,
        'src/util.ts': 1000
    });
    const b = new ContextBudget(idx);
    const r = b.compute(50000);
    assert.equal(r.ordered[0].path, 'src/index.ts');
});

test('config vem antes de arquivo qualquer (sem entry)', () => {
    const idx = make({
        'package.json': 500,
        'src/util.ts': 500
    });
    const b = new ContextBudget(idx);
    const r = b.compute(50000);
    assert.equal(r.ordered[0].path, 'package.json');
});

test('respeita orçamento de tokens', () => {
    const idx = make({
        'a.ts': 5000, 'b.ts': 5000, 'c.ts': 5000
    });
    const b = new ContextBudget(idx);
    const r = b.compute(6000);
    assert.ok(r.totalTokens <= 6000);
    assert.ok(r.omitted.length > 0);
});

test('mustInclude força a entrada', () => {
    const idx = make({
        'src/index.ts': 3000,
        'src/big.ts': 3000
    });
    const b = new ContextBudget(idx);
    const r = b.compute(4000, ['src/big.ts']);
    const included = r.ordered.map(o => o.path);
    assert.ok(included.includes('src/big.ts'));
});

test('pequenos sempre entram (minPerFile)', () => {
    const idx = make({ 'a.ts': 100, 'b.ts': 100, 'c.ts': 100 });
    const b = new ContextBudget(idx);
    const r = b.compute(100000);
    assert.equal(r.omitted.length, 0);
    assert.equal(r.ordered.length, 3);
});

test('tests têm prioridade baixa', () => {
    const idx = make({
        'test/a.test.ts': 1000,
        'src/a.ts': 1000
    });
    const b = new ContextBudget(idx);
    const r = b.compute(1500);
    assert.equal(r.ordered[0].path, 'src/a.ts');
});
