import * as path from 'path';

/**
 * Regras por NOME de arquivo/pasta (sensível, excluído, extensão de texto).
 *
 * A validação da FORMA do caminho (absoluto, traversal, escape por symlink) fica
 * em ./security/pathValidator.ts. Este módulo não resolve caminhos — só olha o
 * caminho relativo já validado e aplica as regras de nomes aqui definidas.
 */

/** Pastas que nunca entram no contexto e nunca podem ser alteradas pelo chat. */
export const EXCLUDED_DIRS = new Set([
    // Dependências / build / VCS
    'node_modules', '.git', 'dist', 'out', 'build', '.next', '.nuxt',
    '.vscode', '.idea', '__pycache__', '.venv', 'venv', 'coverage', 'target',
    // Caches comuns em projetos Next.js / monorepos
    '.turbo', '.vercel', '.cache', '.parcel-cache', '.swc', '.svelte-kit',
    '.angular', '.docusaurus', '.expo', '.gradle', '.mvn', '.yarn',
    'bower_components', 'tmp', 'temp',
    // Saídas que só existem depois de build/generate/install (nunca são fonte):
    // Prisma client gerado (.prisma), Nuxt/Nitro, Vite, Wrangler, Storybook etc.
    '.prisma', '.output', '.nitro', '.vite', '.wrangler', '.sst', '.serverless',
    '.terraform', '.dart_tool', 'Pods', 'DerivedData', '.nyc_output',
    'storybook-static', '.pnpm-store', '.npm', 'jspm_packages',
    '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.eggs',
    '__generated__', '.history',
    // Configs/instruções de ferramentas de IA (skills, regras, prompts):
    // costumam ser volumosas, não são código do projeto e poluem o contexto.
    // Mantê-las aqui as exclui do envio, da tree, do watcher e da escrita.
    '.agents', '.claude', '.windsurf', '.cursor', '.continue', '.aider',
    // Índice, estado e backups locais da própria extensão
    '.deepseek-sync'
]);

/** Dica de extensão para arquivos de texto/código (a leitura em si usa isProbablyBinary). */
export const TEXT_EXTENSIONS = new Set([
    // JS/TS
    '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
    // Dados / docs
    '.json', '.jsonc', '.json5', '.md', '.mdx', '.txt', '.csv', '.tsv',
    // Linguagens comuns
    '.py', '.pyi', '.java', '.kt', '.kts', '.scala',
    '.go', '.rs', '.rb', '.php', '.cs', '.fs', '.vb',
    // Projeto .NET (o ILSpy gera .csproj ao decompilar para projeto)
    '.csproj', '.fsproj', '.vbproj', '.sln', '.props', '.targets', '.resx',
    '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp', '.hh', '.hxx', '.m', '.mm',
    '.html', '.htm', '.css', '.scss', '.sass', '.less', '.styl',
    '.vue', '.svelte', '.astro',
    // Configs / infra
    '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.xml', '.plist',
    '.sql', '.sh', '.bash', '.zsh', '.fish', '.bat', '.ps1', '.cmd',
    '.dart', '.swift', '.lua', '.r', '.gradle', '.properties',
    // Schemas / APIs
    '.graphql', '.gql', '.prisma', '.proto', '.thrift',
    // Vetores / web
    '.svg', '.webmanifest',
    '.lock'
]);

export const TEXT_FILENAMES = new Set([
    'Dockerfile', 'Containerfile', 'Makefile', 'Rakefile', 'Gemfile', 'Procfile',
    'README', 'LICENSE', 'NOTICE', 'CHANGELOG', 'AUTHORS',
    '.gitignore', '.gitattributes', '.gitmodules', '.gitkeep',
    '.dockerignore', '.npmignore', '.eslintignore', '.prettierignore',
    '.editorconfig', '.prettierrc', '.babelrc', '.browserslistrc',
    '.eslintrc', '.swcrc',
    '.nvmrc', '.node-version', '.tool-versions',
    // Templates de env — sem segredos reais; liberados para leitura/escrita
    '.env.example', '.env.sample', '.env.template', '.env.dist'
]);

/** Arquivos sensíveis (bloqueados quando allowSensitiveFiles = false). */
const SENSITIVE_EXTENSIONS = new Set(['.key', '.pem', '.p12', '.pfx', '.crt', '.cer']);
const SENSITIVE_NAMES = new Set([
    'id_rsa', 'id_ed25519', 'id_ecdsa', '.npmrc', '.pypirc', '.netrc',
    'credentials.json', 'secrets.json'
]);

/**
 * Templates de env (`.env.example` etc.) NÃO contêm segredos reais — são
 * documentação. Nunca tratados como sensíveis, para não sumirem do contexto.
 */
const ENV_EXAMPLE_RE = /^\.env\.(example|sample|template|dist|defaults)$/i;

export function isEnvExample(name: string): boolean {
    return ENV_EXAMPLE_RE.test(name);
}

/**
 * Arquivos sensíveis que o chat PODE criar/alterar no disco, mas cujo conteúdo
 * NUNCA é enviado ao modelo quando allowSensitiveFiles = false (o modelo reescreve
 * "às cegas"; o diff no VS Code mostra o conteúdo atual antes de aplicar).
 */
export const WRITABLE_SENSITIVE_NAMES = new Set<string>([
    '.env.local'
]);

/**
 * Quando true, .env, chaves, credenciais etc. NÃO são bloqueados:
 * entram no contexto enviado ao chat e podem ser criados/alterados pelo agente.
 * Configurável em "deepseekContextSync.allowSensitiveFiles".
 *
 * Padrão (Fase 0 do PLANO.md): FALSE — arquivos sensíveis são bloqueados.
 */
let allowSensitive = false;
export function setAllowSensitive(value: boolean) { allowSensitive = value; }
export function isSensitiveAllowed(): boolean { return allowSensitive; }

/** O nome parece de um arquivo sensível (.env, chaves, credenciais)? Ignora a configuração. */
export function looksSensitive(name: string): boolean {
    if (isEnvExample(name)) return false; // templates são seguros
    const lower = name.toLowerCase();
    if (lower === '.env' || lower.startsWith('.env.')) return true;
    if (SENSITIVE_NAMES.has(lower)) return true;
    return SENSITIVE_EXTENSIONS.has(path.posix.extname(lower));
}

/** Bloqueado só quando a liberação (allowSensitiveFiles) está desligada. */
export function isSensitiveName(name: string): boolean {
    if (allowSensitive) return false;
    return looksSensitive(name);
}

/**
 * Sequências de pastas que só existem depois de `prisma generate` / codegen.
 * O nome isolado ("generated") é comum em código escrito à mão, então só as
 * combinações abaixo são tratadas como saída gerada.
 */
const GENERATED_DIR_SEQUENCES: string[][] = [
    ['generated', 'prisma'],
    ['prisma', 'generated'],
    ['generated', 'client'],
    ['@prisma', 'client'],
];

/** Lockfiles: enormes, sem valor para o modelo e regenerados pelo gerenciador de pacotes. */
const NOISE_FILE_NAMES = new Set([
    'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
    'bun.lockb', 'bun.lock', 'composer.lock', 'cargo.lock', 'poetry.lock',
    'pipfile.lock', 'gemfile.lock', 'go.sum', 'pubspec.lock', 'flake.lock',
    '.ds_store', 'thumbs.db'
]);

/** Artefatos de build que podem ficar ao lado do código-fonte. */
const NOISE_SUFFIXES = ['.min.js', '.min.css', '.map', '.tsbuildinfo', '.pyc', '.class'];

function hasDirSequence(dirs: string[], seq: string[]): boolean {
    for (let i = 0; i + seq.length <= dirs.length; i++) {
        let ok = true;
        for (let j = 0; j < seq.length; j++) {
            if (dirs[i + j] !== seq[j]) { ok = false; break; }
        }
        if (ok) return true;
    }
    return false;
}

/** Pastas adicionais definidas pelo usuário (deepseekContextSync.extraExcludedDirs). */
let extraExcluded: string[] = [];
export function setExtraExcludedDirs(list: string[]) {
    extraExcluded = (list || [])
        .map(s => String(s).trim().replace(/^\.?\//, '').replace(/\/+$/, ''))
        .filter(Boolean);
}

function matchesExtra(rel: string): boolean {
    for (const pat of extraExcluded) {
        // "foo" = qualquer pasta/arquivo chamado foo; "a/b" = caminho a partir da raiz
        if (pat.includes('/')) {
            if (rel === pat || rel.startsWith(pat + '/')) return true;
        } else if (rel.split('/').includes(pat)) {
            return true;
        }
    }
    return false;
}

/** Saída de build/geração, dependência ou lockfile: nunca entra no contexto. */
export function isNoisePath(rel: string): boolean {
    const parts = rel.split('/');
    const name = parts[parts.length - 1];
    const lower = name.toLowerCase();
    if (NOISE_FILE_NAMES.has(lower)) return true;
    if (NOISE_SUFFIXES.some(sfx => lower.endsWith(sfx))) return true;
    const dirs = parts.slice(0, -1);
    return GENERATED_DIR_SEQUENCES.some(seq => hasDirSequence(dirs, seq));
}

/**
 * O conteúdo se declara gerado por ferramenta? (Go "Code generated ... DO NOT EDIT",
 * "@generated", cabeçalhos de codegen) ou é JS/CSS minificado? Só olha o começo
 * do arquivo, então é barato. Usado apenas para CONTEXTO, nunca para escrita.
 */
export function looksGeneratedContent(rel: string, text: string): boolean {
    const head = text.slice(0, 600);
    if (/@generated\b|\bDO NOT EDIT\b|\bCode generated\b|\bauto-?generated (?:by|file)\b/i.test(head)) return true;
    if (/\.(?:m?js|cjs|css)$/i.test(rel) && text.length > 8000) {
        const lines = text.split('\n').length;
        if (text.length / lines > 400) return true; // minificado
    }
    return false;
}

/** rel: caminho relativo com "/" (ex.: "src/main.py"). Usado para CONTEXTO (leitura). */
export function isExcludedPath(rel: string): boolean {
    const parts = rel.split('/');
    const name = parts[parts.length - 1];
    return parts.slice(0, -1).some(d => EXCLUDED_DIRS.has(d))
        || isSensitiveName(name)
        || isNoisePath(rel)
        || matchesExtra(rel);
}

/**
 * Mesma ideia de isExcludedPath, mas para ESCRITA (aplicar arquivos do chat).
 * Abre exceções explícitas (WRITABLE_SENSITIVE_NAMES) sem liberar o conteúdo
 * desses arquivos no contexto enviado ao modelo.
 */
/**
 * Nomes GENÉRICOS que só indicam saída de build/cache quando estão na raiz do projeto
 * (ou na raiz de um pacote de monorepo: packages/x/dist). Em qualquer outro nível são
 * pastas de código comuns (src/lib/build/, app/api/tmp/route.ts, internal/target/...).
 * Antes qualquer segmento com esses nomes bloqueava a criação do arquivo, o que
 * fazia arquivos em pastas aninhadas serem recusados ("ficam de fora").
 */
const GENERIC_BUILD_DIRS = new Set(['dist', 'out', 'build', 'target', 'coverage', 'tmp', 'temp', 'bower_components']);
const MONOREPO_ROOTS = new Set(['packages', 'apps', 'libs', 'services', 'modules']);

function isBlockedDirForWrite(dirs: string[], index: number): boolean {
    const d = dirs[index];
    if (!EXCLUDED_DIRS.has(d)) return false;
    if (!GENERIC_BUILD_DIRS.has(d)) return true;           // node_modules, .git, .next, caches...
    if (index === 0) return true;                           // dist/ na raiz
    return index === 2 && MONOREPO_ROOTS.has(dirs[0]);      // packages/x/dist
}

export function isExcludedPathForWrite(rel: string): boolean {
    const parts = rel.split('/');
    const name = parts[parts.length - 1];
    const dirs = parts.slice(0, -1);
    if (dirs.some((_, i) => isBlockedDirForWrite(dirs, i))) return true;
    if (WRITABLE_SENSITIVE_NAMES.has(name)) return false;
    return isSensitiveName(name);
}

/** Dica de extensão (não é "portão" de leitura; o portão é isProbablyBinary). */
export function isTextPath(rel: string): boolean {
    const name = rel.split('/').pop() ?? '';
    if (looksSensitive(name)) return true; // .env etc. têm o conteúdo enviado quando liberados
    return TEXT_EXTENSIONS.has(path.posix.extname(name).toLowerCase())
        || TEXT_FILENAMES.has(name);
}

/**
 * Heurística de binário. Lê os primeiros 8 KB e considera binário se:
 *  - encontrar um byte nulo (0x00), ou
 *  - mais de 30% dos bytes forem controles "estranhos" (excluindo TAB/LF/CR/FF).
 * Isso evita imagens, PDFs, executáveis — mas deixa passar SVG, .env, .lock etc.
 */
export function isProbablyBinary(bytes: Uint8Array): boolean {
    const limit = Math.min(bytes.length, 8192);
    if (limit === 0) return false;
    let suspicious = 0;
    for (let i = 0; i < limit; i++) {
        const b = bytes[i];
        if (b === 0) return true;
        if (b < 7 || (b > 13 && b < 32)) suspicious++;
    }
    return suspicious / limit > 0.3;
}

/**
 * Extensões de binário que vale a pena INSPECIONAR (não só descartar).
 *
 * O conteúdo bruto continua fora do contexto — o que entra é um resumo
 * textual extraído por `peInspector.ts` (imports/exports/seções). Isso deixa
 * o chat raciocinar sobre o binário sem pagar o custo de bytes crus.
 */
const INSPECTABLE_BINARY_EXTENSIONS = new Set([
    '.dll', '.exe', '.sys', '.ocx', '.cpl', '.drv', '.efi', '.scr',
    '.so', '.dylib', '.node', '.elf', '.dll.a',
]);

export function isInspectableBinary(rel: string): boolean {
    const name = rel.split('/').pop() ?? rel;
    return INSPECTABLE_BINARY_EXTENSIONS.has(path.posix.extname(name).toLowerCase());
}

/**
 * Mascara padrões com cara de chave/segredo em uma string antes de escrever em
 * log, OutputChannel ou mensagem de erro (Fase 0 do PLANO.md).
 *
 * Padrões tratados (best-effort, não é criptografia — apenas evita vazamento
 * acidental em log/console):
 *  - chaves OpenAI (sk-...)
 *  - chaves Google API (AIza...)
 *  - tokens GitHub (ghp_, gho_, ghs_, ghr_)
 *  - tokens Slack (xox[baprs]-...)
 *  - blocos PEM (-----BEGIN ... PRIVATE KEY-----)
 *  - chaves genéricas do Gemini (AIza...) já cobertas acima
 */
export function maskSecrets(text: string): string {
    if (!text || typeof text !== 'string') return text;
    return text
        .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/g, 'sk-***MASKED***')
        .replace(/\b(AIza[0-9A-Za-z_-]{20,})\b/g, 'AIza***MASKED***')
        .replace(/\b(ghp_[A-Za-z0-9]{20,})\b/g, 'ghp_***MASKED***')
        .replace(/\b(gho_[A-Za-z0-9]{20,})\b/g, 'gho_***MASKED***')
        .replace(/\b(ghs_[A-Za-z0-9]{20,})\b/g, 'ghs_***MASKED***')
        .replace(/\b(ghr_[A-Za-z0-9]{20,})\b/g, 'ghr_***MASKED***')
        .replace(/\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, 'xox***MASKED***')
        .replace(
            /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----)/g,
            '$1\n***MASKED***\n$2'
        );
}
