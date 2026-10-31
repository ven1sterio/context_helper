// Testes do applyPlan (usa o build em out/; rode via "npm test").
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { planFiles, applyEdit } = require('../out/applyPlan.js');

const ROOT = path.resolve('/proj');
const reader = (files) => (abs) => files[path.relative(ROOT, abs).split(path.sep).join('/')];
const edit = (filePath, search, replace) => ({ filePath, isEdit: true, search, replace });

test('edição exata', () => {
    const r = planFiles([edit('a.js', 'foo', 'bar')], ROOT, reader({ 'a.js': 'x foo y\n' }));
    assert.ok(r.ok);
    assert.equal(r.files[0].content, 'x bar y\n');
});

test('várias edições no mesmo arquivo, em ordem', () => {
    const r = planFiles([edit('a.js', 'one', '1'), edit('a.js', 'two', '2')], ROOT, reader({ 'a.js': 'one two\n' }));
    assert.ok(r.ok);
    assert.equal(r.files[0].content, '1 2\n');
});

test('tolerante: SEARCH sem crases casa com template string e preserva as crases', () => {
    const file = 'style={{ borderLeft: `4px solid ${materia.cor || "#8B85F0"}` }}\n';
    const r = planFiles([edit('p.js',
        'style={{ borderLeft: 4px solid ${materia.cor || "#8B85F0"} }}',
        'style={{ borderLeft: 4px solid ${materia.cor || "#5CB88C"} }}')], ROOT, reader({ 'p.js': file }));
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.files[0].content, 'style={{ borderLeft: `4px solid ${materia.cor || "#5CB88C"}` }}\n');
    assert.ok(r.warnings.some(w => w.includes('tolerante')));
});

test('tolerante: width com crases perdidas', () => {
    const file = 'style={{ width: `${progresso}%`, background: "#8B6FD8" }}\n';
    const r = planFiles([edit('p.js',
        'style={{ width: ${progresso}%, background: "#8B6FD8" }}',
        'style={{ width: ${progresso}%, background: "#5CB88C" }}')], ROOT, reader({ 'p.js': file }));
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.files[0].content, 'style={{ width: `${progresso}%`, background: "#5CB88C" }}\n');
});

test('tolerante: indentação diferente é preservada', () => {
    const file = 'function f() {\n    const cor = c.cor || "#8B6FD8";\n    return cor;\n}\n';
    const r = planFiles([edit('p.js',
        'const cor = c.cor || "#8B6FD8";',
        'const cor = c.cor || "#5CB88C";')], ROOT, reader({ 'p.js': file }));
    assert.ok(r.ok);
    assert.equal(r.files[0].content, 'function f() {\n    const cor = c.cor || "#5CB88C";\n    return cor;\n}\n');
});

test('atômico: SEARCH que não casa rejeita tudo e dá dica da linha parecida', () => {
    const r = planFiles([edit('a.js', 'const x = 2;', 'const x = 3;')], ROOT, reader({ 'a.js': 'const y = 1;\nconst x = 5;\n' }));
    assert.equal(r.ok, false);
    assert.match(r.error, /não aparece/);
    assert.match(r.error, /linha 2/);
});

test('parcial: aplica o que casa e lista o que não casou', () => {
    const files = { 'a.js': 'um\ndois\n', 'b.js': 'tres\n' };
    const r = planFiles([edit('a.js', 'um', '1'), edit('a.js', 'nao existe', 'x'), edit('b.js', 'tres', '3')],
        ROOT, reader(files), { partial: true });
    assert.ok(r.ok);
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0], /edição 2/);
    assert.equal(r.files.find(f => f.rel === 'a.js').content, '1\ndois\n');
    assert.equal(r.files.find(f => f.rel === 'b.js').content, '3\n');
});

test('parcial: se nada casa, falha com a lista de motivos', () => {
    const r = planFiles([edit('a.js', 'nada', 'x')], ROOT, reader({ 'a.js': 'abc\n' }), { partial: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /Nada a aplicar/);
});

test('edição já aplicada vira aviso, não erro', () => {
    const files = { 'a.js': 'const cor = "#5CB88C";\nfim\n', 'b.js': 'x\n' };
    const r = planFiles([edit('a.js', 'const cor = "#8B6FD8";', 'const cor = "#5CB88C";'), edit('b.js', 'x', 'y')], ROOT, reader(files));
    assert.ok(r.ok);
    assert.ok(r.warnings.some(w => w.includes('já parece aplicada')));
    assert.equal(r.files.length, 1);
});

test('SEARCH ambíguo é recusado', () => {
    const r = planFiles([edit('a.js', 'foo', 'bar')], ROOT, reader({ 'a.js': 'foo foo\n' }));
    assert.equal(r.ok, false);
    assert.match(r.error, /2 vezes/);
});

test('CRLF do original é preservado', () => {
    const r = planFiles([edit('a.js', 'a\nb', 'a\nc')], ROOT, reader({ 'a.js': 'a\r\nb\r\n' }));
    assert.ok(r.ok);
    assert.equal(r.files[0].content, 'a\r\nc\r\n');
});

test('caminho com colchetes ([id].js) é aceito', () => {
    const r = planFiles([edit('pages/materias/[id].js', 'a', 'b')], ROOT, reader({ 'pages/materias/[id].js': 'a\n' }));
    assert.ok(r.ok);
});

test('applyEdit: inserção pura (REPLACE só acrescenta)', () => {
    const r = applyEdit('"swr": "^2.2.5"\n},\n', '"swr": "^2.2.5"\n},', '"swr": "^2.2.5",\n"three": "^0.169.0"\n},');
    assert.ok(r.ok);
    assert.equal(r.content, '"swr": "^2.2.5",\n"three": "^0.169.0"\n},\n');
});

test('fora de cerca: reindenta o trecho inserido e avisa', () => {
    const file = 'function init() {\n    let running = false;\n    let lastTime = 0;\n    loop();\n}\n';
    const item = {
        filePath: 'game.js', isEdit: true, unfenced: true,
        search: 'let running = false;\nlet lastTime = 0;',
        replace: 'let running = false;\nlet lastTime = 0;\n\n// Fundo\nconst nc = ctx();\nconst blobs = [\n{ x: 1, y: 2 },\n];\n(() => {\nfoo();\n})();'
    };
    const r = planFiles([item], ROOT, reader({ 'game.js': file }));
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.files[0].content,
        'function init() {\n    let running = false;\n    let lastTime = 0;\n\n    // Fundo\n    const nc = ctx();\n    const blobs = [\n        { x: 1, y: 2 },\n    ];\n    (() => {\n        foo();\n    })();\n    loop();\n}\n');
    assert.ok(r.warnings.some(w => w.includes('fora de cerca')));
});

test('fora de cerca é recusado no modo automático', () => {
    const item = { filePath: 'a.js', isEdit: true, unfenced: true, search: 'x', replace: 'y' };
    const r = planFiles([item], ROOT, reader({ 'a.js': 'x\n' }), { allowUnfenced: false });
    assert.equal(r.ok, false);
    assert.match(r.error, /cerca de código/);
});
