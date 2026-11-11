import { execFile } from 'child_process';

/**
 * Integração com o ILSpy em linha de comando (`ilspycmd`).
 *
 * Instalação (requer .NET SDK):  dotnet tool install --global ilspycmd
 *
 * O ilspycmd só LÊ o assembly (não o executa) e imprime o C# descompilado em
 * stdout. Usamos execFile (sem shell), então o caminho do arquivo nunca é
 * interpretado como comando.
 *
 * Este módulo não depende do `vscode` para poder ser testado isoladamente.
 */

export type DecompileFailure = 'not-installed' | 'timeout' | 'failed';

export type DecompileResult =
    | { ok: true; code: string; truncated: boolean }
    | { ok: false; reason: DecompileFailure; detail: string };

export interface DecompileOptions {
    /** Executável do ilspycmd (nome no PATH ou caminho completo). */
    exePath: string;
    /** Máximo de caracteres de C# mantidos; o excedente é cortado. */
    maxChars: number;
    /** Tempo máximo por assembly. */
    timeoutMs: number;
}

const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

export function decompileAssembly(dllAbsPath: string, opts: DecompileOptions): Promise<DecompileResult> {
    return new Promise(resolve => {
        execFile(
            opts.exePath,
            [dllAbsPath],
            { timeout: opts.timeoutMs, maxBuffer: MAX_STDOUT_BYTES, encoding: 'utf8', windowsHide: true },
            (err, stdout, stderr) => {
                let out = typeof stdout === 'string' ? stdout : '';
                let overflow = false;

                if (err) {
                    const e = err as NodeJS.ErrnoException & { killed?: boolean };
                    if (e.code === 'ENOENT') {
                        return resolve({ ok: false, reason: 'not-installed', detail: opts.exePath });
                    }
                    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && out.length > 0) {
                        overflow = true; // aproveita o que já saiu
                    } else if (e.killed) {
                        return resolve({ ok: false, reason: 'timeout', detail: `>${Math.round(opts.timeoutMs / 1000)}s` });
                    } else {
                        const msg = (typeof stderr === 'string' && stderr.trim()) || e.message;
                        return resolve({ ok: false, reason: 'failed', detail: msg.slice(0, 300) });
                    }
                }

                out = out.trim();
                if (!out) {
                    return resolve({ ok: false, reason: 'failed', detail: 'ilspycmd não devolveu código (assembly vazio ou não gerenciado?)' });
                }

                let truncated = overflow;
                if (out.length > opts.maxChars) {
                    const cut = out.lastIndexOf('\n', opts.maxChars);
                    out = out.slice(0, cut > 0 ? cut : opts.maxChars);
                    truncated = true;
                }
                resolve({ ok: true, code: out, truncated });
            },
        );
    });
}

/** Limita quantas decompilações rodam ao mesmo tempo (cada uma é um processo .NET). */
export class Limiter {
    private running = 0;
    private queue: Array<() => void> = [];
    constructor(private readonly max: number) {}

    run<T>(task: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const start = () => {
                this.running++;
                task().then(resolve, reject).finally(() => {
                    this.running--;
                    const next = this.queue.shift();
                    if (next) next();
                });
            };
            if (this.running < this.max) start();
            else this.queue.push(start);
        });
    }
}

/**
 * DLLs que quase nunca interessam ao chat: runtime/framework e pastas de build
 * intermediário. Evita decompilar centenas de assemblies copiados para bin/.
 */
export function isFrameworkAssembly(rel: string): boolean {
    const parts = rel.split('/');
    const name = (parts[parts.length - 1] ?? '').toLowerCase();
    if (parts.slice(0, -1).some(d => d.toLowerCase() === 'obj')) return true;
    return /^(system|microsoft|windowsbase|presentation|netstandard|mscorlib)(\.|$)/.test(name)
        || name === 'netstandard.dll' || name === 'mscorlib.dll';
}
