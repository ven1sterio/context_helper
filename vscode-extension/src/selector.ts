import { IndexData, FileEntry } from './indexer';

const STOPWORDS = new Set([
  'a', 'o', 'e', 'de', 'da', 'do', 'em', 'para', 'por', 'com', 'sem', 'que', 'se',
  'um', 'uma', 'uns', 'umas', 'no', 'na', 'nos', 'nas', 'ao', 'aos', 'as', 'os',
  'é', 'são', 'foi', 'ser', 'ter', 'tem', 'mais', 'menos', 'muito', 'pouco',
  'esse', 'essa', 'isso', 'este', 'esta', 'isto', 'aquele', 'aquela',
  'the', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'it', 'is', 'are',
  'this', 'that', 'with', 'without', 'for', 'by', 'from', 'as', 'be', 'been',
  'has', 'have', 'had', 'do', 'does', 'did', 'but', 'if', 'then', 'else', 'so',
  'not', 'no', 'yes', 'use', 'using',
  'add', 'create', 'build', 'make', 'change', 'modify', 'update', 'fix',
  'implement', 'write', 'read', 'show', 'run', 'test', 'debug', 'refactor',
  'rename', 'move', 'delete', 'remove', 'preciso', 'quero',
  'mudar', 'muda', 'alterar', 'altera', 'trocar', 'troca', 'ajustar', 'ajusta',
  'melhorar', 'melhora', 'deixar', 'deixa', 'fazer', 'faz', 'novo', 'nova', 'todas', 'todos', 'todo', 'toda',
  'quer', 'queria', 'gostaria', 'pode', 'poder', 'favor', 'tudo', 'coisa'
]);

/** Conceitos em linguagem natural -> termos que aparecem em caminhos/símbolos de projetos web. */
const CONCEPTS: Array<{ words: RegExp; expand: string[]; dirs: string[] }> = [
  { words: /^(tela|telas|p[aá]gina|p[aá]ginas|screen|screens|page|pages|view|views|interface|ui|layout|visual|design|front|frontend)$/,
    expand: ['pages', 'page', 'screen', 'view', 'layout', 'components', 'component', 'styles', 'app'],
    dirs: ['pages/', 'app/', 'src/pages/', 'src/app/', 'views/', 'screens/', 'components/', 'styles/'] },
  { words: /^(estilo|estilos|css|cor|cores|tema|temas|style|styles|theme|visual|design)$/,
    expand: ['styles', 'style', 'css', 'theme', 'global'], dirs: ['styles/', 'public/'] },
  { words: /^(componente|componentes|component|components|bot[aã]o|bot[oõ]es|menu|navbar|sidebar|header|footer|modal)$/,
    expand: ['components', 'component', 'layout', 'header', 'footer'], dirs: ['components/'] },
  { words: /^(login|entrar|cadastro|senha|auth|autentica[cç][aã]o|sess[aã]o)$/,
    expand: ['login', 'cadastro', 'auth', 'senha', 'session'], dirs: ['pages/api/', 'lib/'] },
  { words: /^(banco|dados|database|db|sql|tabela|tabelas|supabase)$/,
    expand: ['supabase', 'sql', 'db', 'client'], dirs: ['sql/', 'lib/'] },
  { words: /^(api|rota|rotas|endpoint|backend|servidor)$/,
    expand: ['api'], dirs: ['pages/api/', 'app/api/'] }
];

export function expandTokens(tokens: string[]): { tokens: string[]; dirs: string[]; broad: boolean } {
  const out = new Set(tokens);
  const dirs = new Set<string>();
  let broad = false;
  for (const t of tokens) {
    for (const c of CONCEPTS) {
      if (c.words.test(t)) {
        c.expand.forEach(e => out.add(e));
        c.dirs.forEach(d => dirs.add(d));
        if (c.dirs.includes('pages/') || c.dirs.includes('components/')) broad = true;
      }
    }
  }
  return { tokens: [...out], dirs: [...dirs], broad };
}

export function tokenize(text: string): string[] {
  if (!text) return [];
  const cleaned = text.toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, ' ');
  const parts = cleaned.split(/\s+/);
  const out: string[] = [];
  for (const p of parts) if (p.length >= 2 && !STOPWORDS.has(p)) out.push(p);
  return out;
}

export interface ScoredFile {
  path: string;
  score: number;
  reasons: string[];
}

function scoreOne(tokens: string[], rel: string, entry: FileEntry): ScoredFile {
  let score = 0;
  const reasons: string[] = [];
  const lower = rel.toLowerCase();
  const base = (rel.split('/').pop() ?? '').toLowerCase();
  const dir = lower.slice(0, lower.length - base.length);
  const symNames = entry.symbols.map(s => s.name.toLowerCase());
  const expNames = entry.exports.map(e => e.toLowerCase());

  for (const t of tokens) {
    let hit = false;
    if (base.includes(t)) { score += 5; reasons.push(`nome:${t}`); hit = true; }
    else if (symNames.some(n => n.includes(t))) { score += 4; reasons.push(`símbolo:${t}`); hit = true; }
    else if (expNames.some(n => n.includes(t))) { score += 3; reasons.push(`export:${t}`); hit = true; }
    else if (dir.includes(t)) { score += 3; reasons.push(`pasta:${t}`); hit = true; }

    if (!hit && entry.tags.length > 0) {
      for (const tag of entry.tags) {
        if (tag.toLowerCase().includes(t)) { score += 2; reasons.push(`tag:${t}`); hit = true; break; }
      }
    }
    if (!hit && entry.summary && entry.summary.toLowerCase().includes(t)) {
      score += 1;
      reasons.push(`resumo:${t}`);
    }
  }
  return { path: rel, score, reasons };
}

function buildReverse(index: IndexData): Map<string, string[]> {
  const reverse = new Map<string, string[]>();
  for (const [rel, entry] of Object.entries(index.files)) {
    for (const imp of entry.imports) {
      if (!index.files[imp]) continue;
      const list = reverse.get(imp) || [];
      list.push(rel);
      reverse.set(imp, list);
    }
  }
  return reverse;
}

export function selectFiles(query: string, index: IndexData, maxFiles = 40): ScoredFile[] {
  const base = tokenize(query);
  if (base.length === 0) return [];
  const { tokens, dirs, broad } = expandTokens(base);

  const scores = new Map<string, ScoredFile>();
  const bump = (rel: string, pts: number, reason: string) => {
    const cur = scores.get(rel);
    if (cur) { cur.score += pts; if (cur.reasons.length < 4 && !cur.reasons.includes(reason)) cur.reasons.push(reason); }
    else scores.set(rel, { path: rel, score: pts, reasons: [reason] });
  };

  // 1) texto literal (tokens originais valem mais que os expandidos)
  for (const rel of Object.keys(index.files)) {
    const scored = scoreOne(tokens, rel, index.files[rel]);
    if (scored.score > 0) scores.set(rel, scored);
  }

  // 2) pastas do conceito (ex.: "telas" -> tudo em pages/, exceto api)
  const lowerPaths = Object.keys(index.files);
  for (const rel of lowerPaths) {
    const l = rel.toLowerCase();
    for (const d of dirs) {
      if (l.startsWith(d) || l.includes('/' + d)) {
        if (d === 'pages/' && l.startsWith('pages/api/') && !base.some(t => /api|rota|endpoint/.test(t))) continue;
        if (/\.(png|jpg|svg|ico|map)$/.test(l)) continue;
        bump(rel, broad ? 6 : 3, `pasta:${d}`);
        break;
      }
    }
  }
  if (scores.size === 0) return [];

  // 3) dependências: segue imports até 2 níveis (o que a tela usa), e quem importa a tela
  const reverse = buildReverse(index);
  const seeds = [...scores.values()].sort((a, b) => b.score - a.score).slice(0, broad ? 30 : 10);
  for (const { path, score } of seeds) {
    const bonus = Math.max(1.5, score * 0.4);
    const walk = (from: string, depth: number) => {
      if (depth > 2) return;
      for (const imp of index.files[from]?.imports || []) {
        if (!index.files[imp]) continue;
        bump(imp, bonus / depth, `usado por ${path}`);
        walk(imp, depth + 1);
      }
    };
    walk(path, 1);
    for (const importer of reverse.get(path) || []) bump(importer, bonus * 0.5, `importa ${path}`);
  }

  const limit = broad ? Math.max(maxFiles, 40) : maxFiles;
  return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

export interface SelectiveResult {
  text: string;
  included: string[];
  skeleton: string[];
  missing: string[];
  chars: number;
  tokens: number;
}

export function buildSelectiveContext(
  paths: string[],
  maxTokens: number,
  files: ReadonlyMap<string, string>,
  index: IndexData
): SelectiveResult {
  const safeTokens = Math.max(1000, Math.min(maxTokens, 500000));
  const maxChars = safeTokens * 4;
  const fullBudget = Math.floor(maxChars * 0.9);
  const skeletonBudget = maxChars - fullBudget;

  // Mantém a ordem de relevância recebida; só arquivos enormes viram esqueleto.
  const ordered = [...new Set(paths)];

  let fullText = '';
  const included: string[] = [];
  const remaining: string[] = [];
  const missing: string[] = [];

  for (const rel of ordered) {
    const content = files.get(rel);
    if (content === undefined) { missing.push(rel); continue; }
    const block = `\n--- ${rel} ---\n${content}\n`;
    if (fullText.length + block.length <= fullBudget) {
      fullText += block;
      included.push(rel);
    } else {
      remaining.push(rel);
    }
  }

  let skelText = '';
  const skeleton: string[] = [];
  if (remaining.length > 0) {
    skelText = '\n\n=== ESQUELETOS (somente assinaturas — peça o arquivo completo se precisar do corpo) ===\n';
    for (const rel of remaining) {
      const content = files.get(rel);
      if (content === undefined) continue;
      const entry = index.files[rel];
      const lines = content.split('\n');
      let block = `\n--- ESQUELETO: ${rel} ---\n`;
      if (entry && entry.symbols.length > 0) {
        for (const sym of entry.symbols) {
          const sig = lines[sym.start - 1] ?? '';
          if (sig.trim()) {
            block += `// ${sym.kind} ${sym.name} (L${sym.start}-${sym.end})\n${sig.trim()}\n`;
          }
        }
      } else if (entry && entry.exports.length > 0) {
        block += `// exports: ${entry.exports.join(', ')}\n`;
      } else {
        block += '// (sem símbolos detectados)\n';
      }
      block += `// ... (${lines.length} linhas no total)\n`;
      if (skelText.length + block.length <= fullText.length + skeletonBudget) {
        skelText += block;
        skeleton.push(rel);
      }
    }
  }

  const text = (fullText + skelText).trim() + '\n';
  return {
    text,
    included,
    skeleton,
    missing,
    chars: text.length,
    tokens: Math.ceil(text.length / 4)
  };
}
