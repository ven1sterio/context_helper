const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// Simula o módulo 'vscode' (só existe dentro do VS Code).
const cfg = {};
const vscodeMock = {
    workspace: { getConfiguration: () => ({ get: (k, d) => (k in cfg ? cfg[k] : d) }) },
    EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
    window: { showInformationMessage() {} },
    FileType: { File: 1 }
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscodeMock : origLoad.call(this, req, ...rest); };
const { ContextManager } = require('../out/contextManager');
Module._load = origLoad;

function makeCm(nFiles, size) {
    const cm = new ContextManager('/ws');
    for (let i = 0; i < nFiles; i++) {
        const rel = `src/mod${String(i).padStart(3, '0')}.ts`;
        cm.files.set(rel, 'x'.repeat(size));
        cm.allPaths.add(rel);
    }
    return cm;
}

test('sendAllContext (padrão): 600 KB saem inteiros, sem omitidos, com manifesto', () => {
    for (const k of Object.keys(cfg)) delete cfg[k];
    const cm = makeCm(600, 1000);                       // ~600 KB > antigo teto de 150–200 KB
    const r = cm.buildFull(150000);                     // o navegador ainda manda o teto do provedor
    assert.equal(r.files, 600);
    assert.equal(r.omitted.length, 0);
    assert.match(r.text, /NENHUM arquivo do projeto foi omitido/);
    assert.ok(r.text.includes('--- src/mod599.ts ---'));
});

test('sendAllContext=false: volta ao teto e o manifesto lista o que ficou de fora', () => {
    for (const k of Object.keys(cfg)) delete cfg[k];
    cfg.sendAllContext = false; cfg.maxTotalKB = 200;
    const cm = makeCm(600, 1000);
    const r = cm.buildFull(150000);
    assert.ok(r.omitted.length > 0 && r.files < 600);
    assert.match(r.text, /Omitidos por limite de tamanho \(\d+\)/);
    assert.ok(r.text.includes(r.omitted[0]));
});

test('árvore avisa quando o conteúdo de um arquivo não foi enviado', () => {
    for (const k of Object.keys(cfg)) delete cfg[k];
    const cm = makeCm(2, 10);
    cm.allPaths.add('assets/big.sql');
    cm.skipped.set('assets/big.sql', 'grande demais: 900 KB > limite de 300 KB');
    const tree = cm.buildTree();
    assert.match(tree, /big\.sql {2}\[conteúdo NÃO enviado: grande demais/);
    const r = cm.buildFull();
    assert.match(r.text, /Presentes no projeto, mas sem conteúdo enviado \(1\)/);
    assert.match(r.text, /assets\/big\.sql/);
});

test('buildFullWithBudget não descarta em silêncio arquivos fora do índice', () => {
    for (const k of Object.keys(cfg)) delete cfg[k];
    const cm = makeCm(3, 100);
    const index = { version: 2, workspaceRoot: '/ws', generatedAt: '', files: {
        'src/mod000.ts': { path: 'src/mod000.ts', tokens: 25, sha1: '', imports: [], exports: [], symbols: [], summary: null, tags: [] }
    } };
    const r = cm.buildFullWithBudget(100000, index);
    assert.equal(r.files, 3);                           // antes: só 1 (os 2 fora do índice sumiam)
    assert.ok(r.text.includes('--- src/mod002.ts ---'));
});
