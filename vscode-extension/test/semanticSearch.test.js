const test = require('node:test');
const assert = require('node:assert/strict');
const { semanticSearch } = require('../out/intelligence/semanticSearch.js');

function entry(rel, symbols = [], exportsList = []) {
    return {
        path: rel, tokens: 50, sha1: '', imports: [],
        exports: exportsList,
        symbols: symbols.map((n, i) => ({ name: n, kind: 'function', start: i + 1, end: i + 5 })),
        summary: null, tags: []
    };
}

function makeIndex() {
    return {
        version: 2, workspaceRoot: '/', generatedAt: '',
        files: {
            'src/contextManager.ts': entry('src/contextManager.ts', ['ContextManager', 'buildFull'], ['ContextManager']),
            'src/selector.ts': entry('src/selector.ts', ['selectFiles', 'tokenize'], ['selectFiles']),
            'src/indexer.ts': entry('src/indexer.ts', ['Indexer'], ['Indexer'])
        }
    };
}

test('query vazia → resultado vazio', () => {
    const r = semanticSearch('', makeIndex(), new Map());
    assert.equal(r.files.length, 0);
});

test('match em nome de arquivo', () => {
    const r = semanticSearch('context', makeIndex(), new Map());
    assert.equal(r.files[0].path, 'src/contextManager.ts');
});

test('match em símbolo', () => {
    const r = semanticSearch('selectfiles', makeIndex(), new Map());
    assert.equal(r.files[0].path, 'src/selector.ts');
});

test('match em conteúdo', () => {
    const contents = new Map([
        ['src/indexer.ts', 'export class Indexer {}'],
        ['src/selector.ts', 'export function selectFiles() {}'],
        ['src/contextManager.ts', 'class ContextManager {}']
    ]);
    const r = semanticSearch('indexer', makeIndex(), contents);
    assert.equal(r.files[0].path, 'src/indexer.ts');
});

test('sem match → lista vazia', () => {
    const r = semanticSearch('xyzabc123', makeIndex(), new Map());
    assert.equal(r.files.length, 0);
});

test('respeita maxFiles', () => {
    const r = semanticSearch('src', makeIndex(), new Map(), 1);
    assert.ok(r.files.length <= 1);
});
