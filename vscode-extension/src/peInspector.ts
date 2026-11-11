import * as crypto from 'crypto';

/**
 * Parser PE mínimo (Portable Executable — DLL/EXE do Windows).
 *
 * Não é desassemblador. Só extrai o que o chat consegue usar para raciocinar
 * sobre um binário:
 *   - cabeçalho COFF/opcional (máquina, subsistema, entry point, image base)
 *   - tabela de seções
 *   - imports (DLLs + funções)
 *   - delay-imports
 *   - exports (nomes)
 *   - SHA-256 do arquivo
 *
 * O conteúdo binário NUNCA vai para o chat. O que vai é o texto formatado
 * por `formatPEInfo` — bem menor e legível para o modelo.
 */

export interface PEImport {
    dll: string;
    functions: string[];
    byOrdinal: number[];
}

export interface PESection {
    name: string;
    virtualAddress: number;
    virtualSize: number;
    rawSize: number;
    rawPointer: number;
    characteristics: number;
}

export interface PEInfo {
    hash: string;
    size: number;
    machine: string;
    isDll: boolean;
    isExe: boolean;
    subsystem: string;
    imageBase: number;
    entryPoint: number;
    numberOfSections: number;
    sections: PESection[];
    imports: PEImport[];
    delayImports: PEImport[];
    exports: string[];
    /** true se há CLR header (assembly .NET gerenciado). */
    isManaged: boolean;
    /** Versão do runtime declarada nos metadados .NET (ex.: v4.0.30319). */
    clrVersion: string;
    /** Namespaces/tipos/métodos/campos (heap #Strings dos metadados .NET). */
    dotnetNames: string[];
    /** Literais de string do código .NET (heap #US). */
    dotnetUserStrings: string[];
    /** Strings ASCII/UTF-16 legíveis (usado quando o binário é nativo). */
    strings: string[];
}

const MACHINES: Record<number, string> = {
    0x014c: 'x86',
    0x8664: 'x64',
    0xaa64: 'arm64',
    0xa641: 'arm64-ec',
    0x01c0: 'arm',
    0x01c4: 'arm-nt',
    0x0200: 'ia64',
    0x5032: 'riscv32',
    0x5064: 'riscv64',
};

const SUBSYSTEMS: Record<number, string> = {
    1: 'native',
    2: 'windows-gui',
    3: 'windows-console',
    5: 'os2-console',
    7: 'posix-console',
    9: 'windows-ce',
    10: 'efi-application',
    11: 'efi-boot-service',
    12: 'efi-runtime',
    13: 'efi-rom',
    14: 'xbox',
    16: 'windows-boot',
};

const MAX_DLLS = 500;
const MAX_FUNCS_PER_DLL = 5000;
const MAX_EXPORTS = 50000;

function u16(buf: Buffer, off: number): number {
    if (off + 2 > buf.length) throw new Error('OOB u16');
    return buf.readUInt16LE(off);
}
function u32(buf: Buffer, off: number): number {
    if (off + 4 > buf.length) throw new Error('OOB u32');
    return buf.readUInt32LE(off);
}
function u64(buf: Buffer, off: number): number {
    const lo = u32(buf, off);
    const hi = u32(buf, off + 4);
    return hi * 0x100000000 + lo;
}

function readCString(buf: Buffer, off: number, maxLen = 512): string {
    if (off < 0 || off >= buf.length) return '';
    const end = Math.min(buf.length, off + maxLen);
    let i = off;
    while (i < end && buf[i] !== 0) i++;
    return buf.toString('ascii', off, i);
}

const MAX_DOTNET_NAMES = 4000;
const MAX_USER_STRINGS = 600;
const MAX_NATIVE_STRINGS = 400;
const MAX_STRING_LEN = 200;
const MIN_STRING_LEN = 6;
const MAX_SCAN_BYTES = 32 * 1024 * 1024;

function clip(s: string): string {
    return s.length > MAX_STRING_LEN ? s.slice(0, MAX_STRING_LEN) + '…' : s;
}

/** Heap #Strings: sequência de strings UTF-8 terminadas em NUL. */
function readStringsHeap(buf: Buffer, start: number, size: number): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const end = Math.min(buf.length, start + size);
    let i = start;
    while (i < end && out.length < MAX_DOTNET_NAMES) {
        let j = i;
        while (j < end && buf[j] !== 0) j++;
        if (j > i) {
            const str = buf.toString('utf8', i, j);
            if (!seen.has(str)) { seen.add(str); out.push(clip(str)); }
        }
        i = j + 1;
    }
    return out;
}

/** Heap #US: blobs com prefixo de tamanho comprimido; conteúdo UTF-16LE + 1 byte de flag. */
function readUserStringsHeap(buf: Buffer, start: number, size: number): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const end = Math.min(buf.length, start + size);
    let i = start + 1; // o primeiro byte do heap é sempre 0
    while (i < end && out.length < MAX_USER_STRINGS) {
        const b = buf[i];
        let len: number;
        if ((b & 0x80) === 0) { len = b; i += 1; }
        else if ((b & 0xc0) === 0x80) { if (i + 2 > end) break; len = ((b & 0x3f) << 8) | buf[i + 1]; i += 2; }
        else if ((b & 0xe0) === 0xc0) { if (i + 4 > end) break; len = ((b & 0x1f) << 24) | (buf[i + 1] << 16) | (buf[i + 2] << 8) | buf[i + 3]; i += 4; }
        else break;
        if (len === 0) continue;
        if (i + len > end) break;
        const str = buf.toString('utf16le', i, i + Math.max(0, len - 1)).trim();
        i += len;
        if (str.length >= 2 && !seen.has(str)) { seen.add(str); out.push(clip(str)); }
    }
    return out;
}

/** Lê metadados .NET a partir do CLR header (data directory 14). */
function readDotNet(
    buf: Buffer,
    clrRVA: number,
    rvaToOffset: (rva: number) => number | null,
): { clrVersion: string; names: string[]; userStrings: string[] } | null {
    const clrOff = rvaToOffset(clrRVA);
    if (clrOff === null || clrOff + 16 > buf.length) return null;
    const mdOff = rvaToOffset(u32(buf, clrOff + 8));
    if (mdOff === null || mdOff + 20 > buf.length) return null;
    if (u32(buf, mdOff) !== 0x424a5342) return null; // "BSJB"

    const verLen = u32(buf, mdOff + 12);
    if (verLen > 255) return null;
    const clrVersion = readCString(buf, mdOff + 16, verLen);
    let p = mdOff + 16 + verLen;
    const streamCount = u16(buf, p + 2);
    p += 4;

    let names: string[] = [];
    let userStrings: string[] = [];
    for (let i = 0; i < streamCount && i < 16; i++) {
        if (p + 8 > buf.length) break;
        const off = u32(buf, p);
        const size = u32(buf, p + 4);
        const name = readCString(buf, p + 8, 32);
        p += 8 + Math.ceil((name.length + 1) / 4) * 4;
        const abs = mdOff + off;
        if (abs >= buf.length) continue;
        if (name === '#Strings') names = readStringsHeap(buf, abs, size);
        else if (name === '#US') userStrings = readUserStringsHeap(buf, abs, size);
    }
    return { clrVersion, names, userStrings };
}

/** Strings ASCII e UTF-16LE legíveis (equivalente simplificado ao `strings`). */
function extractPrintableStrings(buf: Buffer): string[] {
    const end = Math.min(buf.length, MAX_SCAN_BYTES);
    const found: string[] = [];
    const seen = new Set<string>();
    const add = (s: string) => {
        if (seen.has(s) || found.length >= MAX_NATIVE_STRINGS) return;
        // descarta lixo típico (opcodes que parecem texto): exige uma palavra de
        // 4+ letras e que ~90% dos caracteres sejam "de texto normal".
        if (!/[a-z]{3}/.test(s) && !/^[A-Z][A-Z0-9_]{5,}$/.test(s)) return;
        if (/(ATAU|AVAW)/.test(s)) return;
        const normal = s.replace(/[^A-Za-z0-9 _.\-\/\\:;,()%@=<>"'\[\]{}#!?]/g, '').length;
        if (normal / s.length < 0.9) return;
        seen.add(s);
        found.push(clip(s));
    };
    // ASCII
    let start = -1;
    for (let i = 0; i <= end; i++) {
        const c = i < end ? buf[i] : 0;
        const printable = c >= 0x20 && c < 0x7f;
        if (printable) { if (start < 0) start = i; }
        else if (start >= 0) {
            if (i - start >= MIN_STRING_LEN + 2) add(buf.toString('ascii', start, i));
            start = -1;
        }
        if (found.length >= MAX_NATIVE_STRINGS) break;
    }
    // UTF-16LE (ASCII intercalado com 0x00)
    start = -1;
    for (let i = 0; i + 1 <= end; i += 1) {
        const lo = buf[i];
        const hi = i + 1 < end ? buf[i + 1] : 1;
        const ok = hi === 0 && lo >= 0x20 && lo < 0x7f;
        if (ok) { if (start < 0) start = i; i += 1; }
        else if (start >= 0) {
            if ((i - start) / 2 >= MIN_STRING_LEN) add(buf.toString('utf16le', start, i));
            start = -1;
        }
        if (found.length >= MAX_NATIVE_STRINGS) break;
    }
    return found;
}

export function parsePE(buffer: Buffer): PEInfo | null {
    try {
        if (buffer.length < 0x40) return null;
        if (buffer[0] !== 0x4d || buffer[1] !== 0x5a) return null; // "MZ"

        const e_lfanew = u32(buffer, 0x3c);
        if (e_lfanew + 4 + 20 > buffer.length) return null;
        if (buffer[e_lfanew] !== 0x50 || buffer[e_lfanew + 1] !== 0x45) return null; // "PE"
        if (buffer[e_lfanew + 2] !== 0 || buffer[e_lfanew + 3] !== 0) return null;

        const coff = e_lfanew + 4;
        const machine = u16(buffer, coff);
        const numberOfSections = u16(buffer, coff + 2);
        const sizeOfOptionalHeader = u16(buffer, coff + 16);
        const characteristics = u16(buffer, coff + 18);

        const optOff = coff + 20;
        const magic = u16(buffer, optOff);
        const pe32plus = magic === 0x20b;
        if (!pe32plus && magic !== 0x10b) return null;

        const entryPoint = u32(buffer, optOff + 16);
        const imageBase = pe32plus ? u64(buffer, optOff + 24) : u32(buffer, optOff + 28);
        const subsystem = u16(buffer, optOff + 68);

        // Data directories: PE32 em +96, PE32+ em +112. Cada entrada = 8 bytes.
        const dataDirsOff = pe32plus ? optOff + 112 : optOff + 96;
        const exportRVA = u32(buffer, dataDirsOff + 0);
        const exportSize = u32(buffer, dataDirsOff + 4);
        const importRVA = u32(buffer, dataDirsOff + 1 * 8);
        const importSize = u32(buffer, dataDirsOff + 1 * 8 + 4);
        const delayRVA = u32(buffer, dataDirsOff + 13 * 8);
        const delaySize = u32(buffer, dataDirsOff + 13 * 8 + 4);

        // Seções
        const secOff = optOff + sizeOfOptionalHeader;
        const sections: PESection[] = [];
        for (let i = 0; i < numberOfSections; i++) {
            const off = secOff + i * 40;
            if (off + 40 > buffer.length) break;
            const nameRaw = buffer.toString('ascii', off, off + 8).replace(/\0+$/, '');
            sections.push({
                name: nameRaw,
                virtualSize: u32(buffer, off + 8),
                virtualAddress: u32(buffer, off + 12),
                rawSize: u32(buffer, off + 16),
                rawPointer: u32(buffer, off + 20),
                characteristics: u32(buffer, off + 36),
            });
        }

        const rvaToOffset = (rva: number): number | null => {
            for (const s of sections) {
                const span = Math.max(s.virtualSize, s.rawSize);
                if (rva >= s.virtualAddress && rva < s.virtualAddress + span) {
                    return rva - s.virtualAddress + s.rawPointer;
                }
            }
            return null;
        };

        // Exports
        const exportsList: string[] = [];
        if (exportRVA && exportSize) {
            const off = rvaToOffset(exportRVA);
            if (off !== null && off + 40 <= buffer.length) {
                const numberOfNames = u32(buffer, off + 24);
                const addressOfNames = u32(buffer, off + 32);
                const namesOff = rvaToOffset(addressOfNames);
                if (namesOff !== null && numberOfNames < MAX_EXPORTS) {
                    for (let i = 0; i < numberOfNames; i++) {
                        const ptr = namesOff + i * 4;
                        if (ptr + 4 > buffer.length) break;
                        const nameRVA = u32(buffer, ptr);
                        const nameOff = rvaToOffset(nameRVA);
                        if (nameOff !== null) {
                            const name = readCString(buffer, nameOff, 256);
                            if (name) exportsList.push(name);
                        }
                    }
                }
            }
        }

        // Imports
        const imports: PEImport[] = [];
        const thunkSize = pe32plus ? 8 : 4;

        const readThunks = (thunkRVA: number): { functions: string[]; byOrdinal: number[] } => {
            const out: { functions: string[]; byOrdinal: number[] } = { functions: [], byOrdinal: [] };
            const thunkOff = rvaToOffset(thunkRVA);
            if (thunkOff === null) return out;
            let t = thunkOff;
            while (t + thunkSize <= buffer.length) {
                let isOrdinal: boolean;
                let targetRVA: number;
                if (pe32plus) {
                    const lo = u32(buffer, t);
                    const hi = u32(buffer, t + 4);
                    isOrdinal = (hi & 0x80000000) !== 0;
                    targetRVA = lo;
                } else {
                    const v = u32(buffer, t);
                    isOrdinal = (v & 0x80000000) !== 0;
                    targetRVA = v;
                }
                if (!isOrdinal && targetRVA === 0) break; // terminador
                if (isOrdinal && targetRVA === 0 && pe32plus) break;
                if (isOrdinal) {
                    out.byOrdinal.push(targetRVA & 0xffff);
                } else {
                    const hintOff = rvaToOffset(targetRVA);
                    if (hintOff !== null) {
                        const fn = readCString(buffer, hintOff + 2, 256); // pula o hint (2 bytes)
                        if (fn) out.functions.push(fn);
                    }
                }
                t += thunkSize;
                if (out.functions.length + out.byOrdinal.length >= MAX_FUNCS_PER_DLL) break;
            }
            return out;
        };

        if (importRVA && importSize) {
            let off = rvaToOffset(importRVA);
            if (off !== null) {
                while (off + 20 <= buffer.length) {
                    const originalFirstThunk = u32(buffer, off + 0);
                    const nameRVA = u32(buffer, off + 12);
                    const firstThunk = u32(buffer, off + 16);
                    if (!originalFirstThunk && !nameRVA && !firstThunk) break;

                    const nameOff = rvaToOffset(nameRVA);
                    if (nameOff === null) break;
                    const dll = readCString(buffer, nameOff, 256);
                    if (!dll) break;

                    const { functions, byOrdinal } = readThunks(originalFirstThunk || firstThunk);
                    imports.push({ dll, functions, byOrdinal });

                    off += 20;
                    if (imports.length >= MAX_DLLS) break;
                }
            }
        }

        // Delay imports
        const delayImports: PEImport[] = [];
        if (delayRVA && delaySize) {
            let off = rvaToOffset(delayRVA);
            if (off !== null) {
                while (off + 32 <= buffer.length) {
                    const attributes = u32(buffer, off + 0);
                    let nameRVA = u32(buffer, off + 4);
                    let intRVA = u32(buffer, off + 16);
                    if (!nameRVA) break;

                    const isRVA = (attributes & 1) !== 0;
                    if (!isRVA) {
                        nameRVA = nameRVA - imageBase;
                        intRVA = intRVA - imageBase;
                    }
                    const nameOff = rvaToOffset(nameRVA);
                    if (nameOff === null) break;
                    const dll = readCString(buffer, nameOff, 256);
                    if (!dll) break;

                    const { functions, byOrdinal } = readThunks(intRVA);
                    delayImports.push({ dll, functions, byOrdinal });

                    off += 32;
                    if (delayImports.length >= MAX_DLLS) break;
                }
            }
        }

        // .NET gerenciado (data directory 14 = CLR runtime header)
        const clrRVA = u32(buffer, dataDirsOff + 14 * 8);
        const clrSize = u32(buffer, dataDirsOff + 14 * 8 + 4);
        let isManaged = false;
        let clrVersion = '';
        let dotnetNames: string[] = [];
        let dotnetUserStrings: string[] = [];
        if (clrRVA && clrSize) {
            try {
                const dn = readDotNet(buffer, clrRVA, rvaToOffset);
                if (dn) {
                    isManaged = true;
                    clrVersion = dn.clrVersion;
                    dotnetNames = dn.names;
                    dotnetUserStrings = dn.userStrings;
                }
            } catch { /* metadados corrompidos: segue só com o PE */ }
        }
        const strings = isManaged ? [] : extractPrintableStrings(buffer);

        return {
            hash: 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex'),
            size: buffer.length,
            machine: MACHINES[machine] ?? `0x${machine.toString(16)}`,
            isDll: (characteristics & 0x2000) !== 0,
            isExe: (characteristics & 0x0002) !== 0,
            subsystem: SUBSYSTEMS[subsystem] ?? `0x${subsystem.toString(16)}`,
            imageBase,
            entryPoint,
            numberOfSections,
            sections,
            imports,
            delayImports,
            exports: exportsList,
            isManaged,
            clrVersion,
            dotnetNames,
            dotnetUserStrings,
            strings,
        };
    } catch {
        return null;
    }
}

/**
 * Formata o resultado como texto curto para o chat. Corta funções por DLL
 * (50) e exports (100) para não explodir o orçamento de tokens — o modelo
 * só precisa reconhecer "qual DLL é essa e do que depende".
 */
export function formatPEInfo(info: PEInfo, _rel: string): string {
    const lines: string[] = [];
    const kind = info.isDll ? 'DLL' : info.isExe ? 'EXE' : 'binário';
    lines.push(`Tipo: ${kind} (${info.machine}) | Subsistema: ${info.subsystem}`);
    lines.push(`Tamanho: ${info.size} bytes | Imagem base: 0x${info.imageBase.toString(16)} | Entry RVA: 0x${info.entryPoint.toString(16)}`);
    lines.push(`Seções (${info.sections.length}):`);
    for (const s of info.sections) {
        lines.push(`  - ${s.name || '(sem nome)'}: VA=0x${s.virtualAddress.toString(16)} VSize=${s.virtualSize} RawSize=${s.rawSize}`);
    }
    if (info.imports.length > 0) {
        lines.push(`Importa de ${info.imports.length} DLL(s):`);
        for (const imp of info.imports) {
            const fn = imp.functions.slice(0, 50);
            const ord = imp.byOrdinal.slice(0, 20).map(o => `#${o}`);
            const parts = [...fn, ...ord];
            let list = parts.join(', ');
            const total = imp.functions.length + imp.byOrdinal.length;
            if (total > parts.length) list += ` [+${total - parts.length}]`;
            lines.push(`  - ${imp.dll}: ${list || '(nenhuma função nomeada)'}`);
        }
    }
    if (info.delayImports.length > 0) {
        lines.push(`Delay-load (${info.delayImports.length}):`);
        for (const imp of info.delayImports) {
            const fn = imp.functions.slice(0, 30);
            const ord = imp.byOrdinal.slice(0, 10).map(o => `#${o}`);
            const parts = [...fn, ...ord];
            let list = parts.join(', ');
            const total = imp.functions.length + imp.byOrdinal.length;
            if (total > parts.length) list += ` [+${total - parts.length}]`;
            lines.push(`  - ${imp.dll}: ${list || '(nenhuma função nomeada)'}`);
        }
    }
    if (info.exports.length > 0) {
        const show = info.exports.slice(0, 100);
        const tail = info.exports.length > 100 ? ` [+${info.exports.length - 100}]` : '';
        lines.push(`Exporta ${info.exports.length} símbolo(s): ${show.join(', ')}${tail}`);
    } else if (info.isDll) {
        lines.push('Exporta 0 símbolos (DLL só de recursos ou exports só por ordinal).');
    }
    if (info.isManaged) {
        lines.push(`Assembly .NET gerenciado (CLR ${info.clrVersion || '?'}).`);
        if (info.dotnetNames.length > 0) {
            const show = info.dotnetNames.slice(0, 1500);
            const tail = info.dotnetNames.length > show.length ? ` [+${info.dotnetNames.length - show.length}]` : '';
            lines.push(`Nomes nos metadados (namespaces/tipos/métodos/campos, ${info.dotnetNames.length}): ${show.join(', ')}${tail}`);
        }
        if (info.dotnetUserStrings.length > 0) {
            const show = info.dotnetUserStrings.slice(0, 300);
            const tail = info.dotnetUserStrings.length > show.length ? ` [+${info.dotnetUserStrings.length - show.length}]` : '';
            lines.push(`Literais de string no código (${info.dotnetUserStrings.length}):`);
            for (const u of show) lines.push(`  | ${u.replace(/\r?\n/g, '\\n')}`);
            if (tail) lines.push(`  ${tail}`);
        }
    } else if (info.strings.length > 0) {
        lines.push(`Strings legíveis (${info.strings.length}${info.strings.length >= 400 ? '+, truncado' : ''}):`);
        for (const t of info.strings) lines.push(`  | ${t}`);
    }
    return lines.join('\n');
}

/**
 * Atalho: parse + format. Retorna null se não for PE válido.
 * O chamador (contextManager) só inclui no contexto quando isto devolve string.
 */
export function summarizeBinary(buffer: Buffer, rel: string): string | null {
    const info = parsePE(buffer);
    if (!info) return null;
    return formatPEInfo(info, rel);
}
