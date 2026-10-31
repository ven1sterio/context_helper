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
  'quer', 'queria', 'gostaria', 'pode', 'poder', 'favor', 'tudo', 'coisa',
  'está', 'estão', 'esta', 'estao', 'não', 'nao', 'meu', 'minha', 'meus', 'minhas', 'ele', 'ela',
  'como', 'onde', 'porque', 'pq', 'vc', 'você', 'voce', 'aqui', 'já', 'ja', 'ainda', 'também', 'tambem',
  'só', 'so', 'quando', 'agora', 'sempre', 'arquivo', 'arquivos', 'código', 'codigo', 'projeto',
  'ao', 'pelo', 'pela', 'pelos', 'pelas', 'dele', 'dela', 'esse', 'esses', 'essas', 'seu', 'sua'
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

/** Verbos/ideias em português -> identificadores típicos de código (em inglês). */
const SYNONYMS: Array<{ re: RegExp; add: string[] }> = [
  { re: /^(trav|congel|pendur|lent)/, add: ['timeout', 'paste', 'input', 'send', 'wait', 'delay'] },
  { re: /^(cooldown|espera|aguard|delay|intervalo|pausa)/, add: ['delay', 'wait', 'cooldown', 'sleep', 'timeout'] },
  { re: /^(instant|r[aá]pid|imediat|sem(espera|delay))/, add: ['instant', 'delay', 'wait', 'skip'] },
  { re: /^(contexto|context)/, add: ['context', 'prompt', 'tree'] },
  { re: /^(envi|mand|submit)/, add: ['send', 'submit', 'press', 'input'] },
  { re: /^(col(a|ar|ando|ou)|paste)/, add: ['paste', 'insert', 'setinput', 'input'] },
  { re: /^(seletiv|selec|escolh)/, add: ['select', 'selector', 'selection'] },
  { re: /^(respost|resposta|retorno)/, add: ['response', 'answer', 'message'] },
  { re: /^(aplic|gravar|salvar)/, add: ['apply', 'write', 'save'] },
  { re: /^(bot[aã]o|btn|clic)/, add: ['button', 'btn', 'click'] },
  { re: /^(erro|falh|bug|quebr)/, add: ['error', 'fail', 'catch', 'problem'] },
  { re: /^(config|ajuste|op[cç][aã]o|op[cç][oõ]es)/, add: ['config', 'settings', 'option'] },
  { re: /^(agente|aut[oô]nom|loop)/, add: ['agent', 'loop', 'run', 'task'] },
  { re: /^(navegador|extens[aã]o|chrome)/, add: ['browser', 'extension', 'content', 'manifest'] },
  { re: /^(servidor|socket|conex)/, add: ['server', 'socket', 'ws', 'connect'] }
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
  for (const t of tokens) {
    for (const sy of SYNONYMS) if (sy.re.test(t)) sy.add.forEach(e => out.add(e));
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

const lowerCache = new Map<string, { src: string; lower: string }>();
function lowerOf(rel: string, content: string): string {
  const c = lowerCache.get(rel);
  if (c && c.src === content) return c.lower;
  const lower = content.toLowerCase();
  lowerCache.set(rel, { src: content, lower });
  return lower;
}

/** Quantas vezes `t` aparece no texto (limitado, só para ranquear). */
function countHits(hay: string, t: string, cap = 20): number {
  let n = 0, i = 0;
  while (n < cap && (i = hay.indexOf(t, i)) !== -1) { n++; i += t.length; }
  return n;
}

function scoreOne(tokens: string[], rel: string, entry: FileEntry, content?: string): ScoredFile {
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
      hit = true;
    }
    // Conteúdo do arquivo: pega pedidos que não casam com nenhum nome/símbolo.
    if (content && t.length >= 3) {
      const n = countHits(lowerOf(rel, content), t);
      if (n > 0) {
        score += Math.min(4, 1 + Math.log2(n));
        if (!hit && reasons.length < 6) reasons.push(`conteúdo:${t}`);
      }
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

export function selectFiles(
  query: string,
  index: IndexData,
  maxFiles = 40,
  contents?: ReadonlyMap<string, string>
): ScoredFile[] {
  const base = tokenize(query);
  if (base.length === 0) return overviewFiles(index, maxFiles);
  const { tokens, dirs, broad } = expandTokens(base);

  const scores = new Map<string, ScoredFile>();
  const bump = (rel: string, pts: number, reason: string) => {
    const cur = scores.get(rel);
    if (cur) { cur.score += pts; if (cur.reasons.length < 4 && !cur.reasons.includes(reason)) cur.reasons.push(reason); }
    else scores.set(rel, { path: rel, score: pts, reasons: [reason] });
  };

  // 1) texto literal (tokens originais valem mais que os expandidos)
  for (const rel of Object.keys(index.files)) {
    const scored = scoreOne(tokens, rel, index.files[rel], contents?.get(rel));
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
  if (scores.size === 0) return overviewFiles(index, maxFiles);

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
  const ranked = [...scores.values()].sort((a, b) => b.score - a.score).slice(0, limit);

  // Poucos acertos = pedido vago: completa com a visão geral do projeto.
  if (ranked.length < 4) {
    const have = new Set(ranked.map(r => r.path));
    for (const o of overviewFiles(index, 12)) if (!have.has(o.path)) ranked.push(o);
  }
  return ranked;
}

/**
 * Fallback para pedidos que não casam com nada: arquivos "de entrada"
 * (README, manifests, main/index/extension) e os mais importados (hubs).
 */
export function overviewFiles(index: IndexData, maxFiles = 15): ScoredFile[] {
  const reverse = buildReverse(index);
  const out: ScoredFile[] = [];
  for (const [rel, entry] of Object.entries(index.files)) {
    const l = rel.toLowerCase();
    const base = l.split('/').pop() ?? '';
    if (/\.(png|jpe?g|gif|svg|ico|map|lock)$/.test(l) || base === 'package-lock.json') continue;
    if (/(^|\/)(out|dist|build|node_modules)\//.test(l)) continue;
    let score = 0;
    const reasons: string[] = [];
    if (/^readme/.test(base)) { score += 6; reasons.push('visão geral: README'); }
    if (/^(package\.json|manifest\.json|tsconfig\.json|pyproject\.toml|requirements\.txt|cargo\.toml|go\.mod)$/.test(base)) { score += 4; reasons.push('visão geral: config'); }
    if (/^(index|main|app|extension|server|content|background)\.[a-z]+$/.test(base)) { score += 5; reasons.push('visão geral: entrada'); }
    const hubs = (reverse.get(rel) || []).length;
    if (hubs > 0) { score += Math.min(5, hubs); reasons.push(`importado por ${hubs}`); }
    if (score > 0) out.push({ path: rel, score, reasons });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, maxFiles);
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

  const header = `[CONTEXTO SELECIONADO AUTOMATICAMENTE: ${included.length} arquivo(s) completo(s)` +
    (remaining.length ? ` + ${skeleton.length} só como esqueleto` : '') +
    `. Se faltar algum arquivo para responder, diga QUAIS caminhos precisa em vez de supor o conteúdo.]\n`;
  const text = header + (fullText + skelText).trimEnd() + '\n';
  return {
    text,
    included,
    skeleton,
    missing,
    chars: text.length,
    tokens: Math.ceil(text.length / 4)
  };
}
