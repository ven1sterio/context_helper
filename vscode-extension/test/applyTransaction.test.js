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

test('DELETE remove arquivo do disco', async () => {
    const root = tempRoot();
    const file = path.join(root, 'a.txt');
    fs.writeFileSync(file, 'conteudo');
    const tx = new ApplyTransaction(root, async (abs, c) => { await fs.promises.writeFile(abs, c); });
    const r = await tx.run([{ rel: 'a.txt', abs: file, content: '', delete: true }]);
    assert.ok(r.ok);
    assert.deepEqual(r.applied, ['a.txt']);
    assert.equal(fs.existsSync(file), false);
});

test('DELETE não chama verifyFile', async () => {
    const root = tempRoot();
    const file = path.join(root, 'a.txt');
    fs.writeFileSync(file, 'x');
    let verifyCount = 0;
    const tx = new ApplyTransaction(
        root,
        async () => { /* no-op */ },
        async () => { verifyCount++; return true; }
    );
    await tx.run([{ rel: 'a.txt', abs: file, content: '', delete: true }]);
    assert.equal(verifyCount, 0);
});

test('DELETE + rollback restaura o arquivo excluído', async () => {
    const root = tempRoot();
    const a = path.join(root, 'a.txt');
    const b = path.join(root, 'b.txt');
    fs.writeFileSync(a, 'original-a');
    fs.writeFileSync(b, 'original-b');

    // 1ª escrita é do b.txt; o verify dela falha e dispara rollback.
    let writes = 0;
    const tx = new ApplyTransaction(
        root,
        async (abs, c) => { await fs.promises.writeFile(abs, c); writes++; },
        async () => writes < 1
    );
    const r = await tx.run([
        { rel: 'a.txt', abs: a, content: '', delete: true },
        { rel: 'b.txt', abs: b, content: 'novo-b', }
    ]);
    assert.equal(r.ok, false);
    // a.txt foi excluído e depois restaurado
    assert.equal(fs.readFileSync(a, 'utf8'), 'original-a');
    // b.txt nunca foi tocado (verify falhou logo depois da escrita, mas o rollback restaura o conteúdo original)
    assert.equal(fs.readFileSync(b, 'utf8'), 'original-b');
});

test('MOVE renomeia arquivo', async () => {
    const root = tempRoot();
    const from = path.join(root, 'antigo.txt');
    const to = path.join(root, 'novo.txt');
    fs.writeFileSync(from, 'conteudo');

    const tx = new ApplyTransaction(
        root,
        async (abs, c) => { await fs.promises.writeFile(abs, c); }
    );
    const r = await tx.run([
        { rel: 'novo.txt', abs: to, content: '', moveFrom: { rel: 'antigo.txt', abs: from } }
    ]);
    assert.ok(r.ok);
    assert.equal(fs.existsSync(from), false);
    assert.equal(fs.readFileSync(to, 'utf8'), 'conteudo');
});

test('MOVE para destino existente falha e não sobrescreve', async () => {
    const root = tempRoot();
    const from = path.join(root, 'a.txt');
    const to = path.join(root, 'b.txt');
    fs.writeFileSync(from, 'origem');
    fs.writeFileSync(to, 'destino');

    const tx = new ApplyTransaction(
        root,
        async (abs, c) => { await fs.promises.writeFile(abs, c); }
    );
    const r = await tx.run([
        { rel: 'b.txt', abs: to, content: '', moveFrom: { rel: 'a.txt', abs: from } }
    ]);
    assert.equal(r.ok, false);
    // Ambos intactos.
    assert.equal(fs.readFileSync(from, 'utf8'), 'origem');
    assert.equal(fs.readFileSync(to, 'utf8'), 'destino');
});

test('MOVE + falha em outra operação dispara rollback do move', async () => {
    const root = tempRoot();
    const from = path.join(root, 'antigo.txt');
    const to = path.join(root, 'novo.txt');
    const other = path.join(root, 'other.txt');
    fs.writeFileSync(from, 'conteudo');
    fs.writeFileSync(other, 'original');

    let writes = 0;
    const tx = new ApplyTransaction(
        root,
        async (abs, c) => { await fs.promises.writeFile(abs, c); writes++; },
        async () => writes < 1
    );
    const r = await tx.run([
        { rel: 'novo.txt', abs: to, content: '', moveFrom: { rel: 'antigo.txt', abs: from } },
        { rel: 'other.txt', abs: other, content: 'novo' }
    ]);
    assert.equal(r.ok, false);
    // Move foi desfeito: origem existe de novo, destino sumiu.
    assert.equal(fs.existsSync(to), false);
    assert.equal(fs.readFileSync(from, 'utf8'), 'conteudo');
    // other.txt restaurado.
    assert.equal(fs.readFileSync(other, 'utf8'), 'original');
});
