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

test('scanReRequests lê todas as operações', () => {
    const { scanReRequests } = load();
    const r = scanReRequests([
        '### RE: info Qt6OpenGL.dll',
        '### RE: functions Qt6OpenGL.dll filter=Shader limit=20',
        '**RE: decompile bin/Qt6OpenGL.dll QOpenGLEngineSharedShaders**',
        'RE: disasm Qt6OpenGL.dll 0x180001000 count=40',
        '### RE: strings Qt6OpenGL.dll "Program binary received"',
        '### RE: asm a.dll addr=0x180001000 text="mov eax, 1"',
        '### RE: patch a.dll rva=0x1A2B expect="48 89 5C" write="90 90 90"'
    ].join('\n'));
    assert.equal(r.errors.length, 0, r.errors.join('|'));
    assert.equal(r.requests.map(x => x.op).join(','), ['info', 'functions', 'decompile', 'disasm', 'strings', 'asm', 'patch'].join(','));
    assert.equal(r.requests[1].opts.filter, 'Shader');
    assert.equal(r.requests[2].file, 'bin/Qt6OpenGL.dll');
    assert.equal(r.requests[2].args[0], 'QOpenGLEngineSharedShaders');
    assert.equal(r.requests[4].args[0], 'Program binary received');
    assert.equal(r.requests[5].opts.text, 'mov eax, 1');
    assert.equal(r.requests[6].opts.expect, '48 89 5C');
});

test('scanReRequests ignora "RE:" de email e reporta pedidos incompletos', () => {
    const { scanReRequests } = load();
    const r = scanReRequests('RE: reunião amanhã\n### RE: decompile a.dll\n### RE: patch a.dll rva=0x10');
    assert.equal(r.requests.length, 0);
    assert.equal(r.errors.length, 2);
});

test('REPLACE_LINES e FILE não são confundidos com RE', () => {
    const { scanReRequests } = load();
    const r = scanReRequests('### REPLACE_LINES: a.js:1-2\n### FILE: a.js');
    assert.equal(r.requests.length, 0);
    assert.equal(r.errors.length, 0);
});

test('prompt inclui regras RE e buildReResultPrompt avisa sobre blocos ignorados', () => {
    const sb = load();
    assert.match(sb.buildFullPrompt({ tree: 't', context: 'c', question: 'q' }), /### RE: decompile/);
    assert.match(sb.buildFullPrompt({ tree: 't', context: 'c', question: 'q' }), /NÃO responda que "não consegue ver"/);
    const p = sb.buildReResultPrompt({ text: 'x', errors: ['e1'], ignoredFiles: true });
    assert.match(p, /NÃO foram aplicados/);
    assert.match(p, /e1/);
});
