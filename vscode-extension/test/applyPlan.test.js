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

test('DELETE: planeja exclusão de arquivo existente', () => {
    const r = planFiles([{ filePath: 'a.js', delete: true }], ROOT, reader({ 'a.js': 'x\n' }));
    assert.ok(r.ok);
    assert.equal(r.files.length, 1);
    assert.equal(r.files[0].delete, true);
    assert.equal(r.files[0].content, '');
});

test('DELETE: arquivo inexistente falha no modo atômico', () => {
    const r = planFiles([{ filePath: 'nao-existe.js', delete: true }], ROOT, reader({}));
    assert.equal(r.ok, false);
    assert.match(r.error, /não existe/);
});

test('DELETE: arquivo inexistente é pulado no modo parcial (com outra op)', () => {
    const r = planFiles([
        { filePath: 'a.js', content: 'novo\n' },
        { filePath: 'nao-existe.js', delete: true }
    ], ROOT, reader({ 'a.js': 'antigo\n' }), { partial: true });
    assert.ok(r.ok);
    assert.equal(r.files.length, 1);
    assert.equal(r.files[0].rel, 'a.js');
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0], /não existe/);
});

test('DELETE + FILE no mesmo arquivo = conflito', () => {
    const r = planFiles([
        { filePath: 'a.js', content: 'x\n' },
        { filePath: 'a.js', delete: true }
    ], ROOT, reader({ 'a.js': 'antigo\n' }));
    assert.equal(r.ok, false);
    assert.match(r.error, /DELETE/);
});

test('DELETE + EDIT no mesmo arquivo = conflito', () => {
    const r = planFiles([
        { filePath: 'a.js', isEdit: true, search: 'antigo', replace: 'novo' },
        { filePath: 'a.js', delete: true }
    ], ROOT, reader({ 'a.js': 'antigo\n' }));
    assert.equal(r.ok, false);
    assert.match(r.error, /DELETE/);
});

test('DELETE e FILE em arquivos DIFERENTES no mesmo lote é aceito', () => {
    const r = planFiles([
        { filePath: 'a.js', content: 'novo\n' },
        { filePath: 'b.js', delete: true }
    ], ROOT, reader({ 'a.js': 'antigo\n', 'b.js': 'lixo\n' }));
    assert.ok(r.ok);
    const byName = new Map(r.files.map(f => [f.rel, f]));
    assert.equal(byName.get('a.js').delete, undefined);
    assert.equal(byName.get('b.js').delete, true);
});

// ---------- MOVE ----------

test('MOVE: planeja move quando origem existe e destino não', () => {
    const r = planFiles(
        [{ filePath: 'src/novo.js', moveFrom: 'src/antigo.js' }],
        ROOT,
        reader({ 'src/antigo.js': 'x\n' })
    );
    assert.ok(r.ok);
    assert.equal(r.files.length, 1);
    assert.deepEqual(r.files[0].moveFrom, { rel: 'src/antigo.js', abs: path.resolve(ROOT, 'src/antigo.js') });
    assert.equal(r.files[0].rel, 'src/novo.js');
});

test('MOVE: origem inexistente falha no modo atômico', () => {
    const r = planFiles(
        [{ filePath: 'src/novo.js', moveFrom: 'src/nao-existe.js' }],
        ROOT,
        reader({})
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /origem não existe/);
});

test('MOVE: destino já existente falha no modo atômico', () => {
    const r = planFiles(
        [{ filePath: 'src/novo.js', moveFrom: 'src/antigo.js' }],
        ROOT,
        reader({ 'src/antigo.js': 'a\n', 'src/novo.js': 'b\n' })
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /destino já existe/);
});

test('MOVE: origem e destino iguais falha', () => {
    const r = planFiles(
        [{ filePath: 'src/a.js', moveFrom: 'src/a.js' }],
        ROOT,
        reader({ 'src/a.js': 'x\n' })
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /iguais/);
});

test('MOVE + FILE no destino = conflito', () => {
    const r = planFiles(
        [
            { filePath: 'src/b.js', content: 'novo\n' },
            { filePath: 'src/b.js', moveFrom: 'src/a.js' }
        ],
        ROOT,
        reader({ 'src/a.js': 'a\n' })
    );
    assert.equal(r.ok, false);
});

test('MOVE reescreve imports relativos no dependente', () => {
    const files = {
        'src/utils/calc.js': 'export const x = 1;\n',
        'src/app.js': "import { x } from './utils/calc';\nconsole.log(x);\n"
    };
    const r = planFiles(
        [{ filePath: 'src/services/calc.js', moveFrom: 'src/utils/calc.js' }],
        ROOT,
        reader(files),
        {
            findDependents: rel => rel === 'src/utils/calc.js' ? ['src/app.js'] : [],
            allFilePaths: () => new Set(Object.keys(files))
        }
    );
    assert.ok(r.ok, JSON.stringify(r));
    const app = r.files.find(f => f.rel === 'src/app.js');
    assert.ok(app);
    assert.equal(app.content, "import { x } from './services/calc';\nconsole.log(x);\n");
    assert.ok(r.warnings.some(w => w.includes('import(s) reescrito')));
});

test('MOVE preserva alias @/ e detecta base = src/', () => {
    const files = {
        'src/utils/calc.js': 'export const x = 1;\n',
        'src/app.js': "import { x } from '@/utils/calc';\n"
    };
    const r = planFiles(
        [{ filePath: 'src/services/calc.js', moveFrom: 'src/utils/calc.js' }],
        ROOT,
        reader(files),
        {
            findDependents: () => ['src/app.js'],
            allFilePaths: () => new Set(Object.keys(files))
        }
    );
    assert.ok(r.ok, JSON.stringify(r));
    const app = r.files.find(f => f.rel === 'src/app.js');
    assert.ok(app);
    assert.equal(app.content, "import { x } from '@/services/calc';\n");
});

test('MOVE: dependente que o próprio modelo já edita não é reescrito', () => {
    const files = {
        'src/utils/calc.js': 'x\n',
        'src/app.js': "import { x } from './utils/calc';\n"
    };
    const r = planFiles(
        [
            { filePath: 'src/services/calc.js', moveFrom: 'src/utils/calc.js' },
            { filePath: 'src/app.js', isEdit: true, search: 'x', replace: 'y' }
        ],
        ROOT,
        reader(files),
        {
            findDependents: () => ['src/app.js'],
            allFilePaths: () => new Set(Object.keys(files))
        }
    );
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(r.warnings.some(w => w.includes('já estava no lote')));
    // O import não foi tocado, só a edit do modelo aplicada.
    const app = r.files.find(f => f.rel === 'src/app.js');
    assert.ok(app);
    assert.ok(!app.content.includes('services'));
});

test('MOVE reescreve require() do CJS', () => {
    const files = {
        'src/util.js': 'module.exports = {};\n',
        'src/a.js': "const u = require('./util');\n"
    };
    const r = planFiles(
        [{ filePath: 'src/lib/util.js', moveFrom: 'src/util.js' }],
        ROOT,
        reader(files),
        {
            findDependents: () => ['src/a.js'],
            allFilePaths: () => new Set(Object.keys(files))
        }
    );
    assert.ok(r.ok, JSON.stringify(r));
    const a = r.files.find(f => f.rel === 'src/a.js');
    assert.ok(a);
    assert.equal(a.content, "const u = require('./lib/util');\n");
});

// ---------- REPLACE_LINES ----------

test('REPLACE_LINES: substitui range de linhas', () => {
    const orig = 'a\nb\nc\nd\ne\n';
    const r = planFiles(
        [{ filePath: 'x.js', replaceLines: { start: 2, end: 4 }, content: 'B\nC\nD\n' }],
        ROOT,
        reader({ 'x.js': orig })
    );
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.files[0].content, 'a\nB\nC\nD\ne\n');
    assert.deepEqual(r.files[0].replaceLines, { start: 2, end: 4 });
});

test('REPLACE_LINES: linha única (start == end)', () => {
    const r = planFiles(
        [{ filePath: 'x.js', replaceLines: { start: 2, end: 2 }, content: 'NEW\n' }],
        ROOT,
        reader({ 'x.js': 'a\nb\nc\n' })
    );
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.files[0].content, 'a\nNEW\nc\n');
});

test('REPLACE_LINES: apaga linhas com content vazio', () => {
    const r = planFiles(
        [{ filePath: 'x.js', replaceLines: { start: 2, end: 3 }, content: '' }],
        ROOT,
        reader({ 'x.js': 'a\nb\nc\nd\n' })
    );
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.files[0].content, 'a\nd\n');
});

test('REPLACE_LINES: CRLF do original é preservado', () => {
    const r = planFiles(
        [{ filePath: 'x.js', replaceLines: { start: 2, end: 2 }, content: 'NEW\n' }],
        ROOT,
        reader({ 'x.js': 'a\r\nb\r\nc\r\n' })
    );
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.files[0].content, 'a\r\nNEW\r\nc\r\n');
});

test('REPLACE_LINES: end além do total de linhas falha no modo atômico', () => {
    const r = planFiles(
        [{ filePath: 'x.js', replaceLines: { start: 2, end: 99 }, content: 'X\n' }],
        ROOT,
        reader({ 'x.js': 'a\nb\nc\n' })
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /excede o arquivo/);
});

test('REPLACE_LINES: end além do total é pulado no modo parcial', () => {
    const r = planFiles(
        [
            { filePath: 'a.js', content: 'novo\n' },
            { filePath: 'x.js', replaceLines: { start: 2, end: 99 }, content: 'X\n' }
        ],
        ROOT,
        reader({ 'a.js': 'antigo\n', 'x.js': 'a\nb\n' }),
        { partial: true }
    );
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.files.length, 1);
    assert.equal(r.files[0].rel, 'a.js');
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0], /excede/);
});

test('REPLACE_LINES: start < 1 falha', () => {
    const r = planFiles(
        [{ filePath: 'x.js', replaceLines: { start: 0, end: 3 }, content: 'X\n' }],
        ROOT,
        reader({ 'x.js': 'a\nb\nc\n' })
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /range inválido/);
});

test('REPLACE_LINES: end < start falha', () => {
    const r = planFiles(
        [{ filePath: 'x.js', replaceLines: { start: 5, end: 2 }, content: 'X\n' }],
        ROOT,
        reader({ 'x.js': 'a\nb\nc\n' })
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /range inválido/);
});

test('REPLACE_LINES + EDIT no mesmo arquivo = conflito', () => {
    const r = planFiles(
        [
            { filePath: 'x.js', replaceLines: { start: 1, end: 1 }, content: 'A\n' },
            { filePath: 'x.js', isEdit: true, search: 'b', replace: 'B' }
        ],
        ROOT,
        reader({ 'x.js': 'a\nb\nc\n' })
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /REPLACE_LINES/);
});

test('REPLACE_LINES + FILE no mesmo arquivo = conflito', () => {
    const r = planFiles(
        [
            { filePath: 'x.js', replaceLines: { start: 1, end: 1 }, content: 'A\n' },
            { filePath: 'x.js', content: 'inteiro\n' }
        ],
        ROOT,
        reader({ 'x.js': 'a\nb\n' })
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /REPLACE_LINES|FILE/);
});

test('REPLACE_LINES + MOVE no mesmo arquivo = conflito', () => {
    const r = planFiles(
        [
            { filePath: 'x.js', replaceLines: { start: 1, end: 1 }, content: 'A\n' },
            { filePath: 'y.js', moveFrom: 'x.js' }
        ],
        ROOT,
        reader({ 'x.js': 'a\nb\n' })
    );
    assert.equal(r.ok, false);
});

test('REPLACE_LINES em arquivos diferentes é aceito', () => {
    const r = planFiles(
        [
            { filePath: 'a.js', replaceLines: { start: 1, end: 1 }, content: 'A\n' },
            { filePath: 'b.js', replaceLines: { start: 2, end: 2 }, content: 'B\n' }
        ],
        ROOT,
        reader({ 'a.js': 'x\ny\n', 'b.js': 'p\nq\n' })
    );
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.files.length, 2);
});

test('REPLACE_LINES: arquivo inexistente falha no modo atômico', () => {
    const r = planFiles(
        [{ filePath: 'nao-existe.js', replaceLines: { start: 1, end: 1 }, content: 'X\n' }],
        ROOT,
        reader({})
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /não existe/);
});

test('REPLACE_LINES: substitui linha final do arquivo', () => {
    const r = planFiles(
        [{ filePath: 'x.js', replaceLines: { start: 3, end: 3 }, content: 'FIM\n' }],
        ROOT,
        reader({ 'x.js': 'a\nb\nc\n' })
    );
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.files[0].content, 'a\nb\nFIM\n');
});
