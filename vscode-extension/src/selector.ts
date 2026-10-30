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
  'rename', 'move', 'delete', 'remove', 'preciso', 'quero'
]);

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

export function selectFiles(query: string, index: IndexData, maxFiles = 25): ScoredFile[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const scores = new Map<string, ScoredFile>();
  for (const rel of Object.keys(index.files)) {
    const scored = scoreOne(tokens, rel, index.files[rel]);
    if (scored.score > 0) scores.set(rel, scored);
  }
  if (scores.size === 0) return [];

  const reverse = buildReverse(index);
  const top = [...scores.values()].sort((a, b) => b.score - a.score).slice(0, 10);

  for (const { path, score } of top) {
    if (score <= 0) continue;
    const entry = index.files[path];
    if (!entry) continue;
    const bonus = score * 0.3;

    for (const imp of entry.imports) {
      if (!index.files[imp]) continue;
      const existing = scores.get(imp);
      if (existing) {
        existing.score += bonus;
        if (existing.reasons.length < 3) existing.reasons.push(`importado por ${path}`);
      } else {
        scores.set(imp, { path: imp, score: bonus, reasons: [`importado por ${path}`] });
      }
    }
    for (const importer of reverse.get(path) || []) {
      const existing = scores.get(importer);
      if (existing) {
        existing.score += bonus;
        if (existing.reasons.length < 3) existing.reasons.push(`importa ${path}`);
      } else {
        scores.set(importer, { path: importer, score: bonus, reasons: [`importa ${path}`] });
      }
    }
  }

  return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, maxFiles);
}

/**
 * Combina seleção local com sugestões do Gemini. Gemini tem prioridade
 * (bônus de base), mas arquivos locais que o Gemini não citou são mantidos.
 * Arquivos com caminho desconhecido no índice são descartados.
 */
export function mergeWithGemini(
  local: ScoredFile[],
  gemini: Array<{ path: string; reason?: string }>,
  index: IndexData,
  maxFiles = 25
): ScoredFile[] {
  const merged = new Map<string, ScoredFile>();

  for (const g of gemini) {
    if (!g || typeof g.path !== 'string') continue;
    const entry = index.files[g.path];
    if (!entry) continue;
    merged.set(g.path, {
      path: g.path,
      score: 100 + entry.tokens / 100,
      reasons: [g.reason && g.reason.trim() ? `gemini: ${g.reason.trim().slice(0, 60)}` : 'gemini']
    });
  }

  for (const l of local) {
    const existing = merged.get(l.path);
    if (existing) {
      existing.score += l.score;
      for (const r of l.reasons) {
        if (existing.reasons.length < 4 && !existing.reasons.includes(r)) {
          existing.reasons.push(r);
        }
      }
    } else {
      merged.set(l.path, l);
    }
  }

  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, maxFiles);
}

export interface SelectiveResult {
  text: string;
  included: string[];
  skeleton: string[];
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
  const fullBudget = Math.floor(maxChars * 0.7);
  const skeletonBudget = maxChars - fullBudget;

  const ordered = [...new Set(paths)].sort((a, b) => {
    const ca = files.get(a)?.length ?? Infinity;
    const cb = files.get(b)?.length ?? Infinity;
    return ca - cb;
  });

  let fullText = '';
  const included: string[] = [];
  const remaining: string[] = [];

  for (const rel of ordered) {
    const content = files.get(rel);
    if (content === undefined) continue;
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
    chars: text.length,
    tokens: Math.ceil(text.length / 4)
  };
}
