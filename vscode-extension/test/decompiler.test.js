const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decompileAssembly, decompileToProject, isFrameworkAssembly, Limiter } = require('../out/decompiler');

// Usa um "ilspycmd" falso (script sh); não roda no Windows.
const skip = process.platform === 'win32' ? 'script sh não roda no Windows' : false;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-ilspy-'));
function fake(name, body) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
    return p;
}
const base = { maxChars: 10_000, timeoutMs: 5_000 };

test('devolve o C# impresso em stdout', { skip }, async () => {
    const exe = fake('ok', 'echo "public class Cliente { }"; echo "// arg: $1"');
    const r = await decompileAssembly('/x/Lib.dll', { ...base, exePath: exe });
    assert.strictEqual(r.ok, true);
    assert.match(r.code, /public class Cliente/);
    assert.match(r.code, /arg: \/x\/Lib\.dll/);
    assert.strictEqual(r.truncated, false);
});

test('trunca no limite, cortando em fim de linha', { skip }, async () => {
    const exe = fake('big', 'i=0; while [ $i -lt 200 ]; do echo "linha numero $i"; i=$((i+1)); done');
    const r = await decompileAssembly('/x/Lib.dll', { ...base, exePath: exe, maxChars: 300 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.truncated, true);
    assert.ok(r.code.length <= 300);
    assert.ok(!r.code.endsWith('linha numero 1') || r.code.split('\n').every(l => l.startsWith('linha numero')));
});

test('ferramenta não instalada -> not-installed', async () => {
    const r = await decompileAssembly('/x/Lib.dll', { ...base, exePath: '/nao/existe/ilspycmd' });
    assert.deepStrictEqual([r.ok, r.reason], [false, 'not-installed']);
});

test('timeout -> timeout', { skip }, async () => {
    const exe = fake('slow', 'sleep 5');
    const r = await decompileAssembly('/x/Lib.dll', { exePath: exe, maxChars: 1000, timeoutMs: 300 });
    assert.deepStrictEqual([r.ok, r.reason], [false, 'timeout']);
});

test('exit != 0 -> failed com a mensagem do stderr', { skip }, async () => {
    const exe = fake('fail', 'echo "BadImageFormat" >&2; exit 3');
    const r = await decompileAssembly('/x/Lib.dll', { ...base, exePath: exe });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'failed');
    assert.match(r.detail, /BadImageFormat/);
});

test('saída vazia -> failed', { skip }, async () => {
    const exe = fake('empty', 'exit 0');
    const r = await decompileAssembly('/x/Lib.dll', { ...base, exePath: exe });
    assert.deepStrictEqual([r.ok, r.reason], [false, 'failed']);
});

test('isFrameworkAssembly ignora framework e obj/, mantém DLL do projeto', () => {
    assert.strictEqual(isFrameworkAssembly('bin/Debug/System.Text.Json.dll'), true);
    assert.strictEqual(isFrameworkAssembly('bin/Microsoft.Extensions.Logging.dll'), true);
    assert.strictEqual(isFrameworkAssembly('obj/Debug/MeuApp.dll'), true);
    assert.strictEqual(isFrameworkAssembly('libs/MeuApp.Core.dll'), false);
    assert.strictEqual(isFrameworkAssembly('bin/Debug/MeuApp.dll'), false);
});

test('Limiter respeita o máximo de tarefas simultâneas', async () => {
    const lim = new Limiter(2);
    let running = 0, peak = 0;
    const task = () => lim.run(async () => {
        running++; peak = Math.max(peak, running);
        await new Promise(r => setTimeout(r, 20));
        running--;
    });
    await Promise.all([task(), task(), task(), task(), task()]);
    assert.strictEqual(peak, 2);
});

test('decompileToProject: chama ilspycmd -p -o <dir> <dll> e os arquivos aparecem', { skip }, async () => {
    // fake: $1=-p $2=-o $3=<outDir> $4=<dll>
    const exe = fake('proj', 'test "$1" = "-p" && test "$2" = "-o" || exit 9; mkdir -p "$3"; echo "class A {}" > "$3/A.cs"; echo "<Project/>" > "$3/Lib.csproj"');
    const out = path.join(dir, 'saida-projeto');
    const r = await decompileToProject('/x/Lib.dll', out, { exePath: exe, timeoutMs: 5_000 });
    assert.strictEqual(r.ok, true);
    assert.ok(fs.existsSync(path.join(out, 'A.cs')));
    assert.ok(fs.existsSync(path.join(out, 'Lib.csproj')));
});

test('decompileToProject: ferramenta ausente -> not-installed', async () => {
    const r = await decompileToProject('/x/Lib.dll', '/tmp/x', { exePath: '/nao/existe/ilspycmd', timeoutMs: 2_000 });
    assert.deepStrictEqual([r.ok, r.reason], [false, 'not-installed']);
});

test('decompileToProject: falha do ilspycmd -> failed com stderr', { skip }, async () => {
    const exe = fake('projfail', 'echo "not a managed assembly" >&2; exit 1');
    const r = await decompileToProject('/x/Native.dll', path.join(dir, 'o2'), { exePath: exe, timeoutMs: 5_000 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'failed');
    assert.match(r.detail, /not a managed assembly/);
});
