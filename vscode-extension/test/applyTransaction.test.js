const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ApplyTransaction } = require('../out/applyTransaction.js');

function tempRoot() {
    const root = path.resolve(os.tmpdir(), 'ds-tx-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    fs.mkdirSync(root, { recursive: true });
    return root;
}

test('aplica arquivo novo', async () => {
    const root = tempRoot();
    const file = path.join(root, 'a.txt');
    const tx = new ApplyTransaction(root, async (abs, c) => { await fs.promises.writeFile(abs, c); });
    const r = await tx.run([{ rel: 'a.txt', abs: file, content: 'oi' }]);
    assert.ok(r.ok);
    assert.equal(fs.readFileSync(file, 'utf8'), 'oi');
});

test('substitui arquivo existente', async () => {
    const root = tempRoot();
    const file = path.join(root, 'a.txt');
    fs.writeFileSync(file, 'antigo');
    const tx = new ApplyTransaction(root, async (abs, c) => { await fs.promises.writeFile(abs, c); });
    const r = await tx.run([{ rel: 'a.txt', abs: file, content: 'novo' }]);
    assert.ok(r.ok);
    assert.equal(fs.readFileSync(file, 'utf8'), 'novo');
});

test('backup e rollback quando a verificação falha', async () => {
    const root = tempRoot();
    const a = path.join(root, 'a.txt');
    const b = path.join(root, 'b.txt');
    fs.writeFileSync(a, 'original-a');
    fs.writeFileSync(b, 'original-b');

    let writes = 0;
    const tx = new ApplyTransaction(
        root,
        async (abs, c) => { await fs.promises.writeFile(abs, c); writes++; },
        async () => writes < 2 // primeira verificação ok, segunda falha
    );

    const r = await tx.run([
        { rel: 'a.txt', abs: a, content: 'novo-a' },
        { rel: 'b.txt', abs: b, content: 'novo-b' }
    ]);
    assert.equal(r.ok, false);
    assert.equal(fs.readFileSync(a, 'utf8'), 'original-a');
    assert.equal(fs.readFileSync(b, 'utf8'), 'original-b');
});

test('rollback remove arquivo criado na transação', async () => {
    const root = tempRoot();
    const a = path.join(root, 'a.txt');
    const b = path.join(root, 'b.txt');
    fs.writeFileSync(a, 'original-a');

    let writes = 0;
    const tx = new ApplyTransaction(
        root,
        async (abs, c) => { await fs.promises.writeFile(abs, c); writes++; },
        async () => writes < 2
    );
    const r = await tx.run([
        { rel: 'a.txt', abs: a, content: 'novo-a' },
        { rel: 'b.txt', abs: b, content: 'novo-b' }
    ]);
    assert.equal(r.ok, false);
    assert.equal(fs.existsSync(b), false);
    assert.equal(fs.readFileSync(a, 'utf8'), 'original-a');
});

test('transação bem-sucedida mantém os novos conteúdos', async () => {
    const root = tempRoot();
    const a = path.join(root, 'a.txt');
    fs.writeFileSync(a, 'antigo');
    const tx = new ApplyTransaction(root, async (abs, c) => { await fs.promises.writeFile(abs, c); });
    const r = await tx.run([{ rel: 'a.txt', abs: a, content: 'novo' }]);
    assert.ok(r.ok);
    assert.equal(fs.readFileSync(a, 'utf8'), 'novo');
});

test('lista vazia retorna ok sem writes', async () => {
    const root = tempRoot();
    let writes = 0;
    const tx = new ApplyTransaction(root, async () => { writes++; });
    const r = await tx.run([]);
    assert.ok(r.ok);
    assert.equal(writes, 0);
});
