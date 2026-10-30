import * as path from 'path';

/** Pastas que nunca entram no contexto e nunca podem ser alteradas pelo chat. */
export const EXCLUDED_DIRS = new Set([
    // Dependências / build / VCS
    'node_modules', '.git', 'dist', 'out', 'build', '.next', '.nuxt',
    '.vscode', '.idea', '__pycache__', '.venv', 'venv', 'coverage', 'target',
    // Caches comuns em projetos Next.js / monorepos
    '.turbo', '.vercel', '.cache', '.parcel-cache', '.swc', '.svelte-kit',
    '.angular', '.docusaurus', '.expo', '.gradle', '.mvn', '.yarn',
    'bower_components', 'tmp', 'temp',
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
 * Filtro de sensibilidade usado EXCLUSIVAMENTE antes de enviar algo à API do
 * Gemini. Diferente de isSensitiveName(), este filtro vale SEMPRE, mesmo com
 * allowSensitiveFiles = true (que só libera o DeepSeek).
 *
 * Regras (conforme PLANO.md, Fase 0):
 *  - .env e .env.*
 *  - *.pem, *.key, *.p12, *.pfx, *.crt, *.cer
 *  - id_rsa*, id_ed25519*, id_ecdsa*
 *  - secrets.* e credentials.*
 *  - .npmrc, .pypirc, .netrc
 * Exceção: templates .env.example/.sample/.template/.dist são liberados.
 */
export function isSensitiveForGemini(name: string): boolean {
    if (isEnvExample(name)) return false;
    const lower = name.toLowerCase();
    if (lower === '.env' || lower.startsWith('.env.')) return true;
    if (SENSITIVE_NAMES.has(lower)) return true;
    if (/^id_(rsa|ed25519|ecdsa)/.test(lower)) return true;
    if (/^secrets?\./.test(lower)) return true;
    if (/^credentials?\./.test(lower)) return true;
    return SENSITIVE_EXTENSIONS.has(path.posix.extname(lower));
}

/** rel: caminho relativo com "/" (ex.: "src/main.py"). Usado para CONTEXTO (leitura). */
export function isExcludedPath(rel: string): boolean {
    const parts = rel.split('/');
    const name = parts[parts.length - 1];
    return parts.slice(0, -1).some(d => EXCLUDED_DIRS.has(d)) || isSensitiveName(name);
}

/**
 * Mesma ideia de isExcludedPath, mas para ESCRITA (aplicar arquivos do chat).
 * Abre exceções explícitas (WRITABLE_SENSITIVE_NAMES) sem liberar o conteúdo
 * desses arquivos no contexto enviado ao modelo.
 */
export function isExcludedPathForWrite(rel: string): boolean {
    const parts = rel.split('/');
    const name = parts[parts.length - 1];
    if (parts.slice(0, -1).some(d => EXCLUDED_DIRS.has(d))) return true;
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
