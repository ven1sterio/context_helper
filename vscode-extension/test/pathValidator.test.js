const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { validatePath } = require('../out/security/pathValidator.js');

const ROOT = path.resolve(os.tmpdir(), 'ds-test-path-' + Date.now());
fs.mkdirSync(ROOT, { recursive: true });

test('aceita caminho relativo válido', () => {
    const r = validatePath('src/foo.ts', ROOT);
    assert.ok(r.ok);
    assert.equal(r.rel, 'src/foo.ts');
});

test('aceita caminho com subpasta profunda', () => {
    const r = validatePath('a/b/c/d.ts', ROOT);
    assert.ok(r.ok);
    assert.equal(r.rel, 'a/b/c/d.ts');
});

test('rejeita caminho vazio', () => {
    assert.equal(validatePath('', ROOT).ok, false);
});

test('rejeita caminho absoluto unix', () => {
    assert.equal(validatePath('/etc/passwd', ROOT).ok, false);
});

test('rejeita caminho absoluto windows', () => {
    assert.equal(validatePath('C:\\Windows\\system32', ROOT).ok, false);
});

test('rejeita traversal no início', () => {
    assert.equal(validatePath('../etc/passwd', ROOT).ok, false);
});

test('rejeita traversal no meio', () => {
    assert.equal(validatePath('a/../../etc/passwd', ROOT).ok, false);
});

test('rejeita null byte', () => {
    assert.equal(validatePath('a\0b', ROOT).ok, false);
});

test('rejeita segmento vazio', () => {
    assert.equal(validatePath('a//b', ROOT).ok, false);
});

test('rejeita caracteres de controle', () => {
    assert.equal(validatePath('a\x01b', ROOT).ok, false);
});

test('rejeita caminho longo demais', () => {
    assert.equal(validatePath('a'.repeat(2000), ROOT).ok, false);
});

test('normaliza \\ para /', () => {
    const r = validatePath('src\\foo\\bar.ts', ROOT);
    assert.ok(r.ok);
    assert.equal(r.rel, 'src/foo/bar.ts');
});

test('descarta ./ inicial', () => {
    const r = validatePath('./src/foo.ts', ROOT);
    assert.ok(r.ok);
    assert.equal(r.rel, 'src/foo.ts');
});
