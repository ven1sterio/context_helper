const test = require('node:test');
const assert = require('node:assert');
const { parsePE, summarizeBinary } = require('../out/peInspector');

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

test('DLL .NET: extrai tipos, métodos e literais de string', () => {
    const info = parsePE(buildManagedDll());
    assert.ok(info);
    assert.strictEqual(info.isDll, true);
    assert.strictEqual(info.isManaged, true);
    assert.strictEqual(info.clrVersion, 'v4.0.30319');
    assert.ok(info.dotnetNames.includes('ClienteRepository'));
    assert.ok(info.dotnetNames.includes('ObterPorId'));
    assert.deepStrictEqual(info.dotnetUserStrings, ['Server=localhost;Database=vendas', 'Falha ao salvar cliente']);
});

test('summarizeBinary inclui os nomes .NET no texto do contexto', () => {
    const txt = summarizeBinary(buildManagedDll(), 'x.dll');
    assert.match(txt, /Assembly \.NET gerenciado/);
    assert.match(txt, /MeuApp\.Servicos/);
    assert.match(txt, /Falha ao salvar cliente/);
});

test('arquivo que não é PE devolve null', () => {
    assert.strictEqual(summarizeBinary(Buffer.from('console.log(1)'), 'a.js'), null);
});

test('PE truncado/corrompido não lança exceção', () => {
    const buf = buildManagedDll().subarray(0, 0x150);
    assert.doesNotThrow(() => parsePE(buf));
});
