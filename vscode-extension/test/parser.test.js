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
    assert.ok(r.problems.some(p => p.includes('FILE: e EDIT:')), JSON.stringify(r));
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
