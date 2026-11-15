const test = require('node:test');
const assert = require('node:assert/strict');
const { isExcludedPathForWrite } = require('../out/pathRules');

test('pastas genéricas (build, tmp, target...) só bloqueiam na raiz', () => {
    assert.equal(isExcludedPathForWrite('dist/a.js'), true);
    assert.equal(isExcludedPathForWrite('build/a.js'), true);
    assert.equal(isExcludedPathForWrite('src/lib/build/a.ts'), false);
    assert.equal(isExcludedPathForWrite('app/api/tmp/route.ts'), false);
    assert.equal(isExcludedPathForWrite('internal/target/x.go'), false);
});

test('monorepo: packages/x/dist continua protegido', () => {
    assert.equal(isExcludedPathForWrite('packages/ui/dist/a.js'), true);
    assert.equal(isExcludedPathForWrite('packages/ui/src/build/a.ts'), false);
});

test('node_modules/.git/.next continuam protegidos em qualquer nível', () => {
    assert.equal(isExcludedPathForWrite('a/b/node_modules/x/y.js'), true);
    assert.equal(isExcludedPathForWrite('src/.git/config'), true);
    assert.equal(isExcludedPathForWrite('web/.next/server/a.js'), true);
});
