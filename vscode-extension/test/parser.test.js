// Testes do browser-extension/parser.js (carregado em um vm, como script de navegador).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BE = path.join(__dirname, '..', '..', 'browser-extension');

function load(text) {
    const container = {
        innerText: text,
        textContent: text,
        querySelectorAll: () => []   // sem DOM: força o caminho por texto
    };
    const sandbox = {
        window: { DSProvider: {
            findLastAssistantMessage: () => container,
            listAssistantMessages: () => [container],
            messageText: () => text, hasEndMarker: () => true, readStatus: () => null
        } },
        document: { querySelectorAll: () => [] },
        END_MARKER: '[[FIM]]'
    };
    const ctx = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(BE, 'prompt.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(BE, 'parser.js'), 'utf8'), ctx);
    return vm.runInContext('parseLastResponse()', ctx);
}

const USER_PASTE = [
    'EDIT: package.json',
    '<<<<<<< SEARCH',
    '"swr": "^2.2.5"',
    '},',
    '=======',
    '"swr": "^2.2.5",',
    '"three": "^0.169.0"',
    '},',
    '',
    'REPLACE',
    '',
    'EDIT: pages/materias/[id].js',
    '<<<<<<< SEARCH',
    'cor: materia.cor || "#8B6FD8",',
    '=======',
    'cor: materia.cor || "#5CB88C",',
    '',
    'REPLACE',
    '<<<<<<< SEARCH',
    'style={{ borderLeft: 4px solid ${materia.cor || "#8B85F0"} }}',
    '=======',
    'style={{ borderLeft: 4px solid ${materia.cor || "#5CB88C"} }}',
    'REPLACE',
    '<<<<<<< SEARCH',
    'const cor = c.cor || materiaCor || "#8B85F0";',
    '=======',
    'const cor = c.cor || materiaCor || "#5CB88C";',
    'REPLACE',
    '',
    'EDIT: pages/flashcards/index.js',
    '<<<<<<< SEARCH',
    'const cor = c.cor || c.materias?.cor || "#8B6FD8";',
    '=======',
    'const cor = c.cor || c.materias?.cor || "#5CB88C";',
    '>>>>>>> REPLACE'
].join('\n');

test('mantém TODAS as edições do mesmo arquivo (bug do Map)', () => {
    const r = load(USER_PASTE);
    assert.equal(r.error, undefined);
    assert.equal(r.problems.length, 0, JSON.stringify(r.problems));
    const id = r.files.filter(f => f.filePath === 'pages/materias/[id].js');
    assert.equal(id.length, 3);
    assert.equal(r.files.length, 5);
});

test('aceita REPLACE solto no fechamento e SEARCH sem ">>>>>>>"', () => {
    const r = load(USER_PASTE);
    const pkg = r.files.find(f => f.filePath === 'package.json');
    assert.equal(pkg.search, '"swr": "^2.2.5"\n},');
    assert.equal(pkg.replace, '"swr": "^2.2.5",\n"three": "^0.169.0"\n},');
});

test('formato padrão com cercas de código continua funcionando', () => {
    const f = '```';
    const r = load(`Explicação\n\nEDIT: a.js\n${f}js\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n${f}\n\n### FILE: b.js\n${f}js\nconst b = 1;\n${f}\n`);
    assert.equal(r.problems.length, 0, JSON.stringify(r.problems));
    assert.equal(r.files.length, 2);
    assert.equal(r.files.find(x => x.filePath === 'b.js').content, 'const b = 1;\n');
});

test('bloco sem "=======" vira problema explícito (não é descartado em silêncio)', () => {
    const r = load('EDIT: a.js\n<<<<<<< SEARCH\nx\ny\n>>>>>>> REPLACE\n');
    assert.ok(r.problems.some(p => p.includes('=======')), JSON.stringify(r));
});

test('FILE e EDIT no mesmo arquivo continua sendo conflito', () => {
    const f = '```';
    const r = load(`### FILE: a.js\n${f}js\nok\n${f}\n\nEDIT: a.js\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n`);
    assert.ok(r.problems.some(p => p.includes('aparece com mais de um tipo')), JSON.stringify(r));
});

// --- Caso real: "EDIT:" como título e SEARCH/REPLACE em parágrafos (sem cerca) ---
function loadDom(nodes, text) {
    const container = { innerText: text, textContent: text, querySelectorAll: () => nodes };
    const sandbox = {
        window: { DSProvider: {
            findLastAssistantMessage: () => container, listAssistantMessages: () => [container],
            messageText: () => text, hasEndMarker: () => true, readStatus: () => null
        } },
        document: { querySelectorAll: () => [] },
        END_MARKER: '[[FIM]]'
    };
    const ctx = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(BE, 'prompt.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(BE, 'parser.js'), 'utf8'), ctx);
    return vm.runInContext('parseLastResponse()', ctx);
}
const el = (tagName, textContent) => ({ tagName, textContent, closest: () => null });
const pre = (code) => ({ tagName: 'PRE', textContent: code, querySelector: () => null, closest: () => null });

const GAME_BLOCK = [
    '<<<<<<< SEARCH',
    'let running = false;',
    'let lastTime = 0;',
    '=======',
    'let running = false;',
    'let lastTime = 0;',
    '',
    '// Fundo nebula',
    'const nebula = document.createElement(\'canvas\');',
    '(() => {',
    'const nc = nebula.getContext(\'2d\');',
    'const blobs = [',
    '{ x: W * 0.2, y: H * 0.15 },',
    '];',
    '})();'
].join('\n');

test('EDIT em título + SEARCH/REPLACE em parágrafos é recuperado (não depende de <pre>)', () => {
    const nodes = [
        el('H3', 'FILE: style.css'), pre('body { margin: 0; }\n'),
        el('H2', 'EDIT: game.js'), el('P', GAME_BLOCK)
    ];
    const text = 'FILE: style.css\nbody { margin: 0; }\nEDIT: game.js\n' + GAME_BLOCK;
    const r = loadDom(nodes, text);
    assert.equal(r.problems.length, 0, JSON.stringify(r.problems));
    const css = r.files.find(f => f.filePath === 'style.css');
    const js = r.files.find(f => f.filePath === 'game.js');
    assert.ok(css && css.content.includes('margin'));
    assert.ok(js && js.isEdit && js.unfenced === true, JSON.stringify(r.files));
    assert.equal(js.search, 'let running = false;\nlet lastTime = 0;');
});

test('"EDIT:" pendente não adota um <pre> posterior sem relação', () => {
    const nodes = [el('H2', 'EDIT: game.js'), el('P', GAME_BLOCK), el('H3', 'Dica'), pre('.x { color: red; }\n')];
    const r = loadDom(nodes, 'EDIT: game.js\n' + GAME_BLOCK + '\nDica\n.x { color: red; }');
    assert.ok(!r.files.some(f => f.filePath === 'game.js' && !f.isEdit), 'game.js não pode virar arquivo completo');
});

test('### FILE: DENTRO do <pre> (ChatGPT com resposta embrulhada) é recuperado', () => {
    const inline = '### FILE: src/utils/calculadora.js\n```javascript\nfunction somar(a, b) {\n    return a + b;\n}\n```';
    const nodes = [pre(inline)];
    const r = loadDom(nodes, inline);
    assert.equal(r.problems.length, 0, JSON.stringify(r.problems));
    const f = r.files.find(x => x.filePath === 'src/utils/calculadora.js');
    assert.ok(f, JSON.stringify(r.files));
    assert.ok(!f.isEdit);
    assert.match(f.content, /function somar/);
});

test('EDIT: DENTRO do <pre> também é recuperado', () => {
    const inline = 'EDIT: src/app.js\n```text\n<<<<<<< SEARCH\nconsole.log("antigo");\n=======\nconsole.log("novo");\n>>>>>>> REPLACE\n```';
    const nodes = [pre(inline)];
    const r = loadDom(nodes, inline);
    assert.equal(r.problems.length, 0, JSON.stringify(r.problems));
    const f = r.files.find(x => x.filePath === 'src/app.js');
    assert.ok(f && f.isEdit, JSON.stringify(r.files));
    assert.equal(f.search, 'console.log("antigo");');
});

test('FILE e EDIT juntos dentro do MESMO <pre>', () => {
    const inline = [
        '### FILE: a.js', '```js', 'const a = 1;', '```', '',
        'EDIT: b.js', '```text',
        '<<<<<<< SEARCH', 'const b = 2;', '=======', 'const b = 3;', '>>>>>>> REPLACE',
        '```'
    ].join('\n');
    const nodes = [pre(inline)];
    const r = loadDom(nodes, inline);
    assert.equal(r.problems.length, 0, JSON.stringify(r.problems));
    assert.ok(r.files.some(x => x.filePath === 'a.js' && !x.isEdit));
    assert.ok(r.files.some(x => x.filePath === 'b.js' && x.isEdit));
});

test('### DELETE: é reconhecido (sem DOM)', () => {
    const text = 'Vou apagar o antigo.\n\n### DELETE: src/antigo.js\n';
    const r = load(text);
    assert.equal(r.problems.length, 0, JSON.stringify(r.problems));
    const f = r.files.find(x => x.filePath === 'src/antigo.js');
    assert.ok(f);
    assert.equal(f.delete, true);
});

test('### DELETE: dentro de <pre> (ChatGPT embrulhado) é recuperado', () => {
    const text = '### DELETE: src/antigo.js';
    const nodes = [pre(text)];
    const r = loadDom(nodes, text);
    assert.equal(r.problems.length, 0, JSON.stringify(r.problems));
    assert.ok(r.files.some(x => x.filePath === 'src/antigo.js' && x.delete));
});

test('múltiplos ### DELETE: no mesmo <pre>', () => {
    const text = '### DELETE: a.js\n### DELETE: b.js\n';
    const nodes = [pre(text)];
    const r = loadDom(nodes, text);
    assert.equal(r.problems.length, 0, JSON.stringify(r.problems));
    assert.ok(r.files.some(x => x.filePath === 'a.js' && x.delete));
    assert.ok(r.files.some(x => x.filePath === 'b.js' && x.delete));
});

test('### DELETE: + ### FILE: no mesmo <pre>', () => {
    const inline = [
        '### DELETE: lixo.js', '',
        '### FILE: novo.js', '```js', 'const x = 1;', '```'
    ].join('\n');
    const nodes = [pre(inline)];
    const r = loadDom(nodes, inline);
    assert.equal(r.problems.length, 0, JSON.stringify(r.problems));
    assert.ok(r.files.some(x => x.filePath === 'lixo.js' && x.delete));
    assert.ok(r.files.some(x => x.filePath === 'novo.js' && !x.delete && !x.isEdit));
});

test('DELETE + FILE no mesmo arquivo = conflito (problema explícito)', () => {
    const text = '### DELETE: a.js\n\n### FILE: a.js\n```js\nconst x = 1;\n```\n';
    const r = load(text);
    assert.ok(r.problems.some(p => p.includes('a.js') && /FILE|DELETE/.test(p)), JSON.stringify(r.problems));
});

test('### MOVE: origem -> destino é reconhecido', () => {
    const text = 'Vou reorganizar.\n\n### MOVE: src/antigo.js -> src/novo.js\n';
    const r = load(text);
    assert.equal(r.problems.length, 0, JSON.stringify(r.problems));
    const f = r.files.find(x => x.filePath === 'src/novo.js');
    assert.ok(f);
    assert.equal(f.moveFrom, 'src/antigo.js');
});

test('### RENAME: também é aceito (sinônimo de MOVE)', () => {
    const text = '### RENAME: a.js -> b.js';
    const r = load(text);
    assert.equal(r.problems.length, 0, JSON.stringify(r.problems));
    assert.ok(r.files.some(x => x.filePath === 'b.js' && x.moveFrom === 'a.js'));
});

test('MOVE aceita seta "→"', () => {
    const text = '### MOVE: a.js → b.js';
    const r = load(text);
    assert.equal(r.problems.length, 0, JSON.stringify(r.problems));
    assert.ok(r.files.some(x => x.filePath === 'b.js' && x.moveFrom === 'a.js'));
});

test('MOVE dentro de <pre> (ChatGPT embrulhado) é recuperado', () => {
    const text = '### MOVE: src/antigo.js -> src/novo.js';
    const nodes = [pre(text)];
    const r = loadDom(nodes, text);
    assert.equal(r.problems.length, 0, JSON.stringify(r.problems));
    assert.ok(r.files.some(x => x.filePath === 'src/novo.js' && x.moveFrom === 'src/antigo.js'));
});

test('MOVE e FILE no mesmo destino = conflito', () => {
    const text = '### MOVE: a.js -> b.js\n\n### FILE: b.js\n```js\nconst x = 1;\n```\n';
    const r = load(text);
    assert.ok(r.problems.some(p => /b\.js/.test(p)), JSON.stringify(r.problems));
});

test('MOVE e DELETE na mesma origem = conflito', () => {
    const text = '### MOVE: a.js -> b.js\n\n### DELETE: a.js\n';
    const r = load(text);
    assert.ok(r.problems.some(p => /a\.js/.test(p)), JSON.stringify(r.problems));
});

// ---------- REPLACE_LINES ----------

test('### REPLACE_LINES: path:start-end é reconhecido', () => {
    const f = '```';
    const text = `### REPLACE_LINES: src/game.js:45-52\n${f}js\nconst x = 1;\nconst y = 2;\n${f}\n`;
    const r = load(text);
    assert.equal(r.problems.length, 0, JSON.stringify(r.problems));
    const it = r.files.find(x => x.filePath === 'src/game.js');
    assert.ok(it);
    assert.equal(it.replaceLines.start, 45);
    assert.equal(it.replaceLines.end, 52);
    assert.equal(it.content, 'const x = 1;\nconst y = 2;\n');
});

test('### REPLACE_LINES: linha única (sem "-end")', () => {
    const f = '```';
    const text = `### REPLACE_LINES: a.js:7\n${f}js\nnova\n${f}\n`;
    const r = load(text);
    assert.equal(r.problems.length, 0, JSON.stringify(r.problems));
    assert.equal(r.files[0].replaceLines.start, 7);
    assert.equal(r.files[0].replaceLines.end, 7);
});

test('REPLACE_LINES dentro de <pre> (ChatGPT embrulhado) é recuperado', () => {
    const f = '```';
    const text = `### REPLACE_LINES: src/game.js:10-12\n${f}js\nnovo\n${f}`;
    const nodes = [pre(text)];
    const r = loadDom(nodes, text);
    assert.equal(r.problems.length, 0, JSON.stringify(r.problems));
    const it = r.files.find(x => x.filePath === 'src/game.js');
    assert.ok(it, JSON.stringify(r.files));
    assert.equal(it.replaceLines.start, 10);
    assert.equal(it.replaceLines.end, 12);
});

test('duas REPLACE_LINES no mesmo arquivo = conflito', () => {
    const f = '```';
    const text =
        `### REPLACE_LINES: a.js:1-1\n${f}js\nX\n${f}\n\n` +
        `### REPLACE_LINES: a.js:5-5\n${f}js\nY\n${f}\n`;
    const r = load(text);
    assert.ok(r.problems.some(p => /a\.js/.test(p)), JSON.stringify(r.problems));
});

test('REPLACE_LINES + EDIT no mesmo arquivo = conflito', () => {
    const f = '```';
    const text =
        `### REPLACE_LINES: a.js:1-1\n${f}js\nX\n${f}\n\n` +
        `EDIT: a.js\n${f}text\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n${f}\n`;
    const r = load(text);
    assert.ok(r.problems.some(p => /a\.js/.test(p)), JSON.stringify(r.problems));
});

test('REPLACE_LINES + FILE no mesmo arquivo = conflito', () => {
    const f = '```';
    const text =
        `### REPLACE_LINES: a.js:1-1\n${f}js\nX\n${f}\n\n` +
        `### FILE: a.js\n${f}js\ninteiro\n${f}\n`;
    const r = load(text);
    assert.ok(r.problems.some(p => /a\.js/.test(p)), JSON.stringify(r.problems));
});

test('REPLACE_LINES com range inválido vira problema', () => {
    const f = '```';
    const text = `### REPLACE_LINES: a.js:5-2\n${f}js\nX\n${f}\n`;
    const r = load(text);
    assert.ok(!r.files || !r.files.some(x => x.replaceLines), JSON.stringify(r));
});

test('### REPLACE_LINES no mesmo <pre> que ### FILE:', () => {
    const f = '```';
    const inline =
        `### REPLACE_LINES: a.js:3-4\n${f}js\nnovoA\n${f}\n\n` +
        `### FILE: b.js\n${f}js\nconst b = 1;\n${f}`;
    const nodes = [pre(inline)];
    const r = loadDom(nodes, inline);
    assert.equal(r.problems.length, 0, JSON.stringify(r.problems));
    assert.ok(r.files.some(x => x.filePath === 'a.js' && x.replaceLines));
    assert.ok(r.files.some(x => x.filePath === 'b.js' && !x.replaceLines));
});
