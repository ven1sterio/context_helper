const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    handleReRequests,
    readPeLayout,
    rvaToFileOffset,
    locateBinary,
    validateGhidraOutput
} = require('../out/reBridge');
const { validateMessage } = require('../out/security/messageValidator');

// O teste do .NET continua usando um script sh simulado para o ilspycmd.
// Por isso a flag permanece; só o teste do Ghidra deixa de usá-la.
const skipWin = process.platform === 'win32' ? 'script sh não roda no Windows' : false;

/** Monta um PE32+ mínimo com CLR header + metadados .NET (#Strings e #US). */
function buildManagedDll() {
    const pad4 = b => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
    const us = s => { const d = Buffer.concat([Buffer.from(s, 'utf16le'), Buffer.from([0])]); return Buffer.concat([Buffer.from([d.length]), d]); };
    const strings = pad4(Buffer.from('\0<Module>\0MeuApp.Servicos\0ClienteRepository\0ObterPorId\0'));
    const usHeap = pad4(Buffer.concat([Buffer.from([0]), us('Server=localhost;Database=vendas'), us('Falha ao salvar cliente')]));
    const ver = Buffer.from('v4.0.30319\0\0');
    const streams = [[Buffer.from('#Strings\0\0\0\0'), strings], [Buffer.from('#US\0'), usHeap]];
    let off = 16 + ver.length + 4 + streams.reduce((a, [n]) => a + 8 + n.length, 0);
    const hdrs = [], bodies = [];
    for (const [n, d] of streams) {
        const h = Buffer.alloc(8); h.writeUInt32LE(off, 0); h.writeUInt32LE(d.length, 4);
        hdrs.push(h, n); bodies.push(d); off += d.length;
    }
    const root = Buffer.alloc(16); root.write('BSJB', 0); root.writeUInt16LE(1, 4); root.writeUInt16LE(1, 6); root.writeUInt32LE(ver.length, 12);
    const flags = Buffer.alloc(4); flags.writeUInt16LE(streams.length, 2);
    const md = Buffer.concat([root, ver, flags, ...hdrs, ...bodies]);
    const clr = Buffer.alloc(72); clr.writeUInt32LE(72, 0); clr.writeUInt32LE(0x2000 + 72, 8); clr.writeUInt32LE(md.length, 12);
    const text = Buffer.concat([clr, md]);
    const raw = (text.length + 0x1ff) & ~0x1ff;

    const dos = Buffer.alloc(0x80); dos.write('MZ', 0); dos.writeUInt32LE(0x80, 0x3c);
    const coff = Buffer.alloc(20); coff.writeUInt16LE(0x8664, 0); coff.writeUInt16LE(1, 2); coff.writeUInt16LE(240, 16); coff.writeUInt16LE(0x2022, 18);
    const opt = Buffer.alloc(240); opt.writeUInt16LE(0x20b, 0); opt.writeUInt32LE(0x2000, 32); opt.writeUInt32LE(0x200, 36); opt.writeUInt16LE(3, 68);
    opt.writeUInt32LE(0x2000, 112 + 14 * 8); opt.writeUInt32LE(72, 112 + 14 * 8 + 4);
    const sec = Buffer.alloc(40); sec.write('.text', 0); sec.writeUInt32LE(text.length, 8); sec.writeUInt32LE(0x2000, 12); sec.writeUInt32LE(raw, 16); sec.writeUInt32LE(0x200, 20);
    const head = Buffer.concat([dos, Buffer.from('PE\0\0'), coff, opt, sec]);
    return Buffer.concat([head, Buffer.alloc(0x200 - head.length), text, Buffer.alloc(raw - text.length)]);
}


// PE64 nativo mínimo: 1 seção .text (VA 0x1000, raw 0x400, 0x200 bytes) com bytes 48 89 5C 24 08 na RVA 0x1010.
function buildNativeDll() {
    const b = Buffer.alloc(0x600);
    b.writeUInt16LE(0x5A4D, 0); b.writeUInt32LE(0x80, 0x3C);
    b.write('PE\0\0', 0x80, 'latin1');
    b.writeUInt16LE(0x8664, 0x84); b.writeUInt16LE(1, 0x86); b.writeUInt16LE(0xF0, 0x94); b.writeUInt16LE(0x2022, 0x96);
    const opt = 0x98;
    b.writeUInt16LE(0x20b, opt);
    b.writeBigUInt64LE(0x180000000n, opt + 24);
    b.writeUInt32LE(0x1000, opt + 32); b.writeUInt32LE(0x200, opt + 36);
    const sh = opt + 0xF0;
    b.write('.text', sh, 'latin1');
    b.writeUInt32LE(0x200, sh + 8); b.writeUInt32LE(0x1000, sh + 12);
    b.writeUInt32LE(0x200, sh + 16); b.writeUInt32LE(0x400, sh + 20);
    Buffer.from('48895C2408', 'hex').copy(b, 0x410);
    return b;
}

function workspace() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rebridge-'));
    fs.mkdirSync(path.join(d, 'bin'));
    fs.writeFileSync(path.join(d, 'bin', 'x.dll'), buildNativeDll());
    fs.writeFileSync(path.join(d, 'bin', 'Lib.dll'), buildManagedDll());
    return d;
}
const patchReq = (opts, file = 'x.dll') => ({ op: 'patch', file, args: [], opts });
const yes = async () => true;

test('layout PE e RVA→offset', () => {
    const pe = readPeLayout(buildNativeDll());
    assert.equal(pe.imageBase, 0x180000000n);
    assert.equal(rvaToFileOffset(pe, 0x1010).offset, 0x410);
    assert.throws(() => rvaToFileOffset(pe, 0x5000));
});

test('patch grava cópia .patched e preserva o original (addr com imagebase)', async () => {
    const d = workspace();
    const r = await handleReRequests([patchReq({ addr: '0x180001010', expect: '48 89 5C 24 08', write: '90 90 90 90 90' })], { workspaceRoot: d, confirm: yes });
    assert.equal(r.ok, true, r.text);
    assert.equal(fs.readFileSync(path.join(d, 'bin', 'x.dll')).subarray(0x410, 0x415).toString('hex'), '48895c2408');
    assert.equal(fs.readFileSync(path.join(d, 'bin', 'x.patched.dll')).subarray(0x410, 0x415).toString('hex'), '9090909090');
});

test('patch recusa: bytes diferentes, tamanhos diferentes, usuário nega, sem confirm', async () => {
    const d = workspace();
    const ctx = { workspaceRoot: d, confirm: yes };
    assert.match((await handleReRequests([patchReq({ rva: '0x1010', expect: '00 00', write: '90 90' })], ctx)).text, /NÃO são os esperados/);
    assert.match((await handleReRequests([patchReq({ rva: '0x1010', expect: '48 89', write: '90' })], ctx)).text, /mesmo tamanho/);
    assert.match((await handleReRequests([patchReq({ rva: '0x1010', expect: '48 89', write: '90 90' })], { workspaceRoot: d, confirm: async () => false })).text, /NÃO aplicado/);
    assert.match((await handleReRequests([patchReq({ rva: '0x1010', expect: '48 89', write: '90 90' })], { workspaceRoot: d })).text, /NÃO aplicado/);
    assert.equal(fs.existsSync(path.join(d, 'bin', 'x.patched.dll')), false);
});

test('inplace faz backup .orig; caminho fora do workspace e extensão inválida são barrados', async () => {
    const d = workspace();
    let r = await handleReRequests([patchReq({ rva: '0x1010', expect: '48 89', write: '90 90', inplace: 'true' })], { workspaceRoot: d, confirm: yes });
    assert.equal(r.ok, true, r.text);
    assert.ok(fs.existsSync(path.join(d, 'bin', 'x.dll.orig')));
    r = await handleReRequests([patchReq({ rva: '0x1010', expect: '48', write: '90' }, '../../etc/x.dll')], { workspaceRoot: d, confirm: yes });
    assert.match(r.text, /fora do workspace/);
    r = await handleReRequests([patchReq({ rva: '0x1010', expect: '48', write: '90' }, 'notas.txt')], { workspaceRoot: d, confirm: yes });
    assert.match(r.text, /extensão não suportada/);
    assert.throws(() => locateBinary(d, 'inexistente.dll'), /não encontrado/);
});

test('nativo sem Ghidra configurado dá erro claro', async () => {
    const d = workspace();
    const r = await handleReRequests([{ op: 'info', file: 'x.dll', args: [], opts: {} }], { workspaceRoot: d });
    assert.equal(r.ok, false);
    assert.match(r.text, /ghidraPath|GHIDRA_HOME/);
});

function createFakeGhidra(home, log, output = 'saida fake', exitCode = 0) {
    const support = path.join(home, 'support');
    fs.mkdirSync(support, { recursive: true });

    const launcher = process.platform === 'win32'
        ? path.join(support, 'analyzeHeadless.bat')
        : path.join(support, 'analyzeHeadless');

    const resultLine = String(output).replace(/[\r\n]+/g, ' ');

    if (process.platform === 'win32') {
        const script = [
            '@echo off',
            'setlocal DisableDelayedExpansion',
            `>>"${log}" echo %*`,
            'set "LAST_ARG="',
            'for %%A in (%*) do set "LAST_ARG=%%~A"',
            'if not defined LAST_ARG exit /b 2',
            `>"%LAST_ARG%" echo ${resultLine}`,
            `exit /b ${exitCode}`
        ].join('\r\n');

        fs.writeFileSync(launcher, script, 'utf8');
    } else {
        const shellQuote = value =>
            "'" + String(value).replace(/'/g, "'\\''") + "'";

        const script = [
            '#!/bin/sh',
            `printf '%s\\n' "$*" >> ${shellQuote(log)}`,
            'for arg do last="$arg"; done',
            `printf '%s\\n' ${shellQuote(resultLine)} > "$last"`,
            `exit ${exitCode}`
        ].join('\n');

        fs.writeFileSync(launcher, script, { encoding: 'utf8', mode: 0o755 });
    }

    return launcher;
}

test('nativo com Ghidra simulado: Windows e Unix, cache e segunda chamada com -process', async () => {
    const d = workspace();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fake ghidra '));
    const log = path.join(home, 'calls.log');

    createFakeGhidra(home, log);

    const ctx = { workspaceRoot: d, ghidraHome: home, cacheDir: d + '-cache' };

    const r1 = await handleReRequests([
        { op: 'decompile', file: 'x.dll', args: ['Foo'], opts: {} }
    ], ctx);

    const r2 = await handleReRequests([
        { op: 'functions', file: 'x.dll', args: [], opts: { limit: '5' } }
    ], ctx);

    assert.equal(r1.ok, true, r1.text);
    assert.equal(r2.ok, true, r2.text);
    assert.match(r1.text, /saida fake/);
    assert.match(r2.text, /saida fake/);

    const calls = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/);

    assert.equal(calls.length, 2);
    assert.match(calls[0], /-import/);
    assert.match(calls[1], /-process.*x\.dll.*-noanalysis.*-readOnly/);
    assert.match(calls[1], /ReBridge\.java/);

    assert.ok(fs.existsSync(path.join(d + '-cache', 'ghidra')));
    assert.ok(fs.existsSync(
        fs.readdirSync(path.join(d + '-cache', 'ghidra'))
            .map(name => path.join(d + '-cache', 'ghidra', name))
            .find(file => file.endsWith('.analyzed'))
    ));
});

test('Ghidra rejeita saída vazia e erros emitidos pelo ReBridge.java', async () => {
    assert.throws(
        () => validateGhidraOutput(''),
        /saída vazia/
    );

    assert.throws(
        () => validateGhidraOutput('[[RE_BRIDGE_ERROR]] falha simulada'),
        /reportou uma falha/
    );

    assert.equal(validateGhidraOutput('resultado válido'), 'resultado válido');

    const d = workspace();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-ghidra-error-'));
    const log = path.join(home, 'calls.log');

    createFakeGhidra(home, log, '[[RE_BRIDGE_ERROR]] falha simulada');

    const r = await handleReRequests([
        { op: 'decompile', file: 'x.dll', args: ['Foo'], opts: {} }
    ], { workspaceRoot: d, ghidraHome: home, cacheDir: d + '-cache' });

    assert.equal(r.ok, false);
    assert.match(r.text, /reportou uma falha/);

    const cache = path.join(d + '-cache', 'ghidra');
    assert.equal(
        fs.readdirSync(cache).some(name => name.endsWith('.analyzed')),
        false,
        'um projeto com erro não pode ser marcado como analisado'
    );
});

test('Ghidra rejeita código de saída diferente de zero mesmo quando existe arquivo de resultado', async () => {
    const d = workspace();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-ghidra-exit-'));
    const log = path.join(home, 'calls.log');

    createFakeGhidra(home, log, 'saida fake', 17);

    const r = await handleReRequests([
        { op: 'info', file: 'x.dll', args: [], opts: {} }
    ], { workspaceRoot: d, ghidraHome: home, cacheDir: d + '-cache' });

    assert.equal(r.ok, false);
    assert.match(r.text, /código 17/);

    const cache = path.join(d + '-cache', 'ghidra');
    assert.equal(
        fs.readdirSync(cache).some(name => name.endsWith('.analyzed')),
        false
    );
});

test('.NET: info/functions/strings usam os metadados; decompile e disasm usam o ilspycmd', { skip: skipWin }, async () => {
    const d = workspace();
    const exe = path.join(d, 'fake-ilspy');
    fs.writeFileSync(exe, '#!/bin/sh\necho "ARGS: $@"\n', { mode: 0o755 });
    const ctx = { workspaceRoot: d, ilspyPath: exe };
    const run = (op, args = [], opts = {}) => handleReRequests([{ op, file: 'Lib.dll', args, opts }], ctx);
    assert.match((await run('info')).text, /\.NET \(gerenciado\)/);
    assert.match((await run('functions', [], { filter: 'cliente' })).text, /ClienteRepository/);
    assert.match((await run('strings', ['localhost'])).text, /Server=localhost/);
    assert.match((await run('decompile', ['MeuApp.Servicos.ClienteRepository'])).text, /ARGS: -t MeuApp\.Servicos\.ClienteRepository .*Lib\.dll/);
    assert.match((await run('disasm', ['MeuApp.Servicos.ClienteRepository'])).text, /ARGS: -t MeuApp\.Servicos\.ClienteRepository -il/);
    assert.match((await run('xrefs', ['Foo'])).text, /não existe para binários \.NET/);
    const bad = await run('decompile', ['--help']);
    assert.equal(bad.ok, false);
    assert.match(bad.text, /nome de tipo inválido/);
});

test('validateMessage aceita reRequest válido e rejeita os inválidos', () => {
    const ok = validateMessage({ type: 'reRequest', requests: [{ op: 'decompile', file: 'a.dll', args: ['F'], opts: { count: '3' } }] });
    assert.equal(ok.ok, true);
    assert.equal(validateMessage({ type: 'reRequest', requests: [] }).ok, false);
    assert.equal(validateMessage({ type: 'reRequest', requests: [{ op: 'rm', file: 'a.dll', args: [] }] }).ok, false);
    assert.equal(validateMessage({ type: 'reRequest', requests: [{ op: 'info', file: 'a.dll', args: [1] }] }).ok, false);
    assert.equal(validateMessage({ type: 'reRequest', requests: [{ op: 'info', file: 'a.dll', opts: { 'A;b': 'x' } }] }).ok, false);
    assert.equal(validateMessage({ type: 'reRequest', requests: Array(9).fill({ op: 'info', file: 'a.dll' }) }).ok, false);
});

test('projeto Ghidra nunca usa caminho com segmento iniciado por ponto (erro real do Ghidra 12)', { skip: skipWin }, async () => {
    const { hasDotSegment, resolveGhidraCacheDir } = require('../out/reBridge');
    assert.equal(hasDotSegment('C:\\a\\.deepseek-sync\\re'), true);
    assert.equal(hasDotSegment('/a/b.c/d'), false);
    assert.equal(hasDotSegment('/a/../b'), false);

    const d = workspace();
    // cacheDir inválido (com ponto) → cai para a pasta temporária sem ponto
    assert.equal(hasDotSegment(resolveGhidraCacheDir({ workspaceRoot: d, cacheDir: path.join(d, '.deepseek-sync', 're') })), false);
    // sem cacheDir → também sem ponto (e nunca dentro do workspace)
    assert.equal(hasDotSegment(resolveGhidraCacheDir({ workspaceRoot: d })), false);

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-ghidra-dot-'));
    const log = path.join(home, 'calls.log');
    createFakeGhidra(home, log);
    const r = await handleReRequests([{ op: 'info', file: 'x.dll', args: [], opts: {} }],
        { workspaceRoot: d, ghidraHome: home, cacheDir: path.join(d, '.deepseek-sync', 're') });
    assert.equal(r.ok, true, r.text);
    const firstArg = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/)[0].split(' ')[0];
    assert.equal(hasDotSegment(firstArg), false, 'o Ghidra recebeu: ' + firstArg);
});
