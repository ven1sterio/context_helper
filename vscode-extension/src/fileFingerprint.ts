import * as crypto from 'crypto';
import * as fs from 'fs';

/**
 * Identificadores de conteúdo para detectar se um arquivo mudou desde que o
 * contexto foi enviado ao modelo. Será usado na Fase 2 (Full Code 2.0) e na
 * detecção de conflitos do ApplyManager.
 */
export type Fingerprint = string;

export function hashContent(content: string): Fingerprint {
    return 'sha1:' + crypto.createHash('sha1').update(content, 'utf8').digest('hex');
}

export function hashBuffer(buf: Buffer): Fingerprint {
    return 'sha1:' + crypto.createHash('sha1').update(buf).digest('hex');
}

export function fingerprintFile(abs: string): Fingerprint | null {
    try { return hashBuffer(fs.readFileSync(abs)); }
    catch { return null; }
}

export interface FingerprintMismatch {
    filePath: string;
    expected: Fingerprint;
    actual: Fingerprint | null;
}

/**
 * Confere se os arquivos esperados continuam com o conteúdo original.
 * Devolve a lista dos que mudaram (ou sumiram).
 *
 * `expected`: caminho relativo → fingerprint registrado no envio do contexto.
 * `absPathOf`: como transformar o caminho relativo em absoluto.
 */
export function detectChanges(
    expected: Map<string, Fingerprint>,
    absPathOf: (rel: string) => string
): FingerprintMismatch[] {
    const out: FingerprintMismatch[] = [];
    for (const [rel, fp] of expected) {
        const actual = fingerprintFile(absPathOf(rel));
        if (actual !== fp) out.push({ filePath: rel, expected: fp, actual });
    }
    return out;
}
