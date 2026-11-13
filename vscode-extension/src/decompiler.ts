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

export function decompileAssembly(dllAbsPath: string, opts: DecompileOptions, extraArgs: string[] = []): Promise<DecompileResult> {
    return new Promise(resolve => {
        execFile(
            opts.exePath,
            [...extraArgs, dllAbsPath],
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

/** Nome de tipo aceito por `ilspycmd -t` (nunca começa com "-", para não virar opção). */
export function isSafeTypeName(name: string): boolean {
    return /^[A-Za-z_][\w.`+<>,\[\]]{0,300}$/.test(name);
}

/** Decompila UM tipo (`ilspycmd -t Namespace.Classe`); com `il: true` devolve IL em vez de C#. */
export function decompileType(
    dllAbsPath: string,
    typeName: string,
    opts: DecompileOptions & { il?: boolean },
): Promise<DecompileResult> {
    if (!isSafeTypeName(typeName)) {
        return Promise.resolve({ ok: false, reason: 'failed', detail: 'nome de tipo inválido' });
    }
    const extra = ['-t', typeName];
    if (opts.il) extra.push('-il');
    return decompileAssembly(dllAbsPath, opts, extra);
}

export type ProjectDecompileResult =
    | { ok: true }
    | { ok: false; reason: DecompileFailure; detail: string };

/**
 * Decompila o assembly INTEIRO como um projeto C# (.csproj + um .cs por tipo)
 * dentro de `outDir`, para a IA editar os arquivos e o usuário recompilar com
 * `dotnet build`. Equivale a: ilspycmd -p -o <outDir> <dll>
 */
export function decompileToProject(
    dllAbsPath: string,
    outDir: string,
    opts: { exePath: string; timeoutMs: number },
): Promise<ProjectDecompileResult> {
    return new Promise(resolve => {
        execFile(
            opts.exePath,
            ['-p', '-o', outDir, dllAbsPath],
            { timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
            (err, _stdout, stderr) => {
                if (!err) return resolve({ ok: true });
                const e = err as NodeJS.ErrnoException & { killed?: boolean };
                if (e.code === 'ENOENT') return resolve({ ok: false, reason: 'not-installed', detail: opts.exePath });
                if (e.killed) return resolve({ ok: false, reason: 'timeout', detail: `>${Math.round(opts.timeoutMs / 1000)}s` });
                const msg = (typeof stderr === 'string' && stderr.trim()) || e.message;
                resolve({ ok: false, reason: 'failed', detail: msg.slice(0, 300) });
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
