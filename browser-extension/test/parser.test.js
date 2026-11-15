// Testa o parser de blocos EDIT/FILE (executado em vm, sem DOM).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BE = path.join(__dirname, '..');
function load() {
    const sb = { window: {}, document: {}, console };
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(path.join(BE, 'prompt.js'), 'utf8'), sb);
    vm.runInContext(fs.readFileSync(path.join(BE, 'parser.js'), 'utf8'), sb);
    return sb;
}
const F = '`'.repeat(3);

test('formato novo [[SEARCH]]/[[REPLACE]]/[[END]] é lido', () => {
    const { parseItemsFromText } = load();
    const w = [];
    const r = parseItemsFromText(['EDIT: src/a.ts', F + 'text', '[[SEARCH]]', '    old();', '[[REPLACE]]', '    novo();', '[[END]]', F].join('\n'), w);
    assert.equal(w.length, 0, w.join('|'));
    assert.equal(r.length, 1);
    assert.equal(r[0].filePath, 'src/a.ts');
    assert.equal(r[0].search, '    old();');
    assert.equal(r[0].replace, '    novo();');
});

test('formato novo: vários blocos no mesmo EDIT', () => {
    const { parseItemsFromText } = load();
    const w = [];
    const r = parseItemsFromText(['EDIT: a.ts', '[[SEARCH]]', 'x', '[[REPLACE]]', 'y', '[[END]]', '[[SEARCH]]', 'z', '[[REPLACE]]', 'w', '[[END]]'].join('\n'), w);
    assert.equal(r.length, 2);
    assert.equal(r[1].replace, 'w');
});

test('formato antigo <<<<<<< / ======= / >>>>>>> continua funcionando', () => {
    const { parseItemsFromText } = load();
    const w = [];
    const r = parseItemsFromText(['EDIT: a.ts', '<<<<<<< SEARCH', 'x', '=======', 'y', '>>>>>>> REPLACE'].join('\n'), w);
    assert.equal(w.length, 0);
    assert.equal(r.length, 1);
    assert.equal(r[0].replace, 'y');
});

test('formato antigo sem "=======" (o chat apagou) avisa de forma útil', () => {
    const { parseItemsFromText } = load();
    const w = [];
    const r = parseItemsFromText(['EDIT: vscode-extension/src/reBridge.ts', '<<<<<<< SEARCH', 'x', 'y', '>>>>>>> REPLACE'].join('\n'), w);
    assert.equal(r.length, 0);
    assert.equal(w.length, 1);
    assert.match(w[0], /\[\[REPLACE\]\]/);
});

test('FILE: com cerca não é confundido com EDIT novo', () => {
    const { parseItemsFromText } = load();
    const r = parseItemsFromText(['### FILE: a.js', F + 'js', 'const a = 1;', F].join('\n'), []);
    assert.equal(r.length, 1);
    assert.equal(r[0].content, 'const a = 1;\n');
});

test('prompt ensina o formato novo e não o antigo', () => {
    const sb = load();
    const RESPONSE_RULES = vm.runInContext('RESPONSE_RULES', sb);
    assert.ok(RESPONSE_RULES.includes('[[SEARCH]]'));
    assert.ok(RESPONSE_RULES.includes('[[END]]'));
    assert.ok(!RESPONSE_RULES.includes('>>>>>>> REPLACE'));
});

// ---- caminhos aninhados: markdown renderizado come os sublinhados ----
function fakeNode(tag, children) {
    return { nodeType: 1, tagName: tag, childNodes: children.map(c => typeof c === 'string' ? { nodeType: 3, nodeValue: c } : c), get nextSibling() { return null; } };
}
function link(parent) {
    parent.childNodes.forEach((c, i) => { Object.defineProperty(c, 'nextSibling', { get: () => parent.childNodes[i + 1] || null, configurable: true }); if (c.childNodes) link(c); });
    return parent;
}

test('rawMarkdownText restaura __tests__ comido pelo markdown (<strong>)', () => {
    const { rawMarkdownText } = load();
    const h = link(fakeNode('H3', ['FILE: src/components/', fakeNode('STRONG', ['tests']), '/Button.test.tsx']));
    assert.equal(rawMarkdownText(h).trim(), 'FILE: src/components/__tests__/Button.test.tsx');
});

test('rawMarkdownText restaura __init__.py e não mexe em negrito de linha inteira', () => {
    const { rawMarkdownText } = load();
    const a = link(fakeNode('P', ['FILE: app/pkg/', fakeNode('STRONG', ['init']), '.py']));
    assert.equal(rawMarkdownText(a).trim(), 'FILE: app/pkg/__init__.py');
    const b = link(fakeNode('P', [fakeNode('STRONG', ['FILE: src/a/b/c.ts'])]));
    assert.equal(rawMarkdownText(b).trim(), 'FILE: src/a/b/c.ts');
});

test('caminho com 3+ pastas e crases é lido por inteiro', () => {
    const { parseItemsFromText } = load();
    const r = parseItemsFromText(['### FILE: `src/app/(auth)/[locale]/login/page.tsx`', F + 'tsx', 'export default 1;', F].join('\n'), []);
    assert.equal(r.length, 1);
    assert.equal(r[0].filePath, 'src/app/(auth)/[locale]/login/page.tsx');
});
