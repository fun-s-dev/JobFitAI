/**
 * Pure helpers that rank a user's repositories against the requirements of a job description.
 * No I/O: embeddings are passed in, so everything here is deterministic and unit-testable.
 *
 * A repository is represented by retrieval chunks (description, technology stack, README passages).
 * Each job requirement is compared with every chunk of the repository; the best match per requirement
 * is what the repository "covers". Keyword presence is a second, independent signal.
 */
const { chunkText } = require('./chunker');
const { normalizeText } = require('./normalizeText');
const { cosineSimilarity } = require('./cosineSimilarity');
const { scaleSimilarity } = require('./similarityScore');

// Kept small on purpose: the free embedding tier allows about 90 texts per minute, and a ranking embeds
// every chunk of up to 15 repositories (results are cached by text, so a repeat run is free).
const MAX_CHUNKS_PER_REPO = 14;

// Similarity scale, measured on the REAL gemini-embedding-001 (768 dimensions, SEMANTIC_SIMILARITY):
// even completely unrelated text scores about 0.76-0.82 cosine against a job requirement, and clearly
// relevant passages score about 0.82-0.89. So the scale starts near the top of the unrelated range
// (a guessed 0.5-0.85 scale gave an unrelated game repo the same score as a partly relevant one).
// Calibrated on a small sample of five repositories; re-check it when real data is available.
const DEFAULT_LO = 0.78;
const DEFAULT_HI = 0.88;
// A passage is only shown as the reason for a match above this cosine (the unrelated ceiling was 0.817)
const DEFAULT_MATCH_THRESHOLD = 0.82;
const IMPORTANCE_WEIGHT = Object.freeze({ must: 1, nice: 0.5 });

// Final score = 0.7 x semantic coverage + 0.3 x keyword coverage (semantic only if no requirement has keywords)
const SEMANTIC_WEIGHT = 0.7;
const KEYWORD_WEIGHT = 0.3;

/** Escapes a string for use inside a RegExp. */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when `keyword` occurs in `text` as a whole term (not inside a longer word),
 * so "go" does not match "mongo" and "java" does not match "javascript".
 */
function containsTerm(text, keyword) {
  const k = String(keyword || '').trim();
  if (!k) return false;
  const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(k.toLowerCase())}($|[^a-z0-9])`, 'i');
  return re.test(String(text || '').toLowerCase());
}

/**
 * Builds the retrieval chunks of a repository analysis.
 * Order: description, technology stack, then README passages (so a cap drops README tail first).
 *
 * @param {object} analysis - GithubAnalysis document (plain or lean)
 * @param {{ maxChunks?: number }} [options]
 * @returns {{ chunks: Array<{id:string, source:string, text:string, embedText:string}>, repoText: string }}
 */
function buildRepoChunks(analysis, { maxChunks = MAX_CHUNKS_PER_REPO } = {}) {
  const chunks = [];
  const fullName = (analysis && analysis.repositoryFullName) || '';
  const repoName = fullName.split('/').pop();

  const description = analysis && typeof analysis.description === 'string' ? analysis.description.trim() : '';
  if (description) {
    chunks.push({
      id: 'metadata_chunk_0',
      source: 'metadata',
      section: 'Repository description',
      text: description,
      embedText: `${repoName}: ${description}`,
      start: 0,
      end: description.length,
    });
  }

  const stack = [];
  if (analysis && analysis.languages && typeof analysis.languages === 'object') {
    stack.push(...Object.keys(analysis.languages));
  }
  if (analysis && Array.isArray(analysis.dependencies)) {
    for (const d of analysis.dependencies) {
      if (d && d.name) stack.push(d.name);
    }
  }
  const uniqueStack = [...new Set(stack)].slice(0, 40);
  if (uniqueStack.length > 0) {
    const text = `Technologies used: ${uniqueStack.join(', ')}`;
    chunks.push({
      id: 'stack_chunk_0',
      source: 'dependencies',
      section: 'Technology stack',
      text,
      embedText: `${repoName}. ${text}`,
      start: 0,
      end: text.length,
    });
  }

  const readme = analysis && typeof analysis.readmeText === 'string' ? normalizeText(analysis.readmeText) : '';
  if (readme) {
    const readmeChunks = chunkText(readme, { source: 'readme', maxChars: 500 });
    for (const c of readmeChunks) {
      chunks.push({
        id: c.id,
        source: 'readme',
        section: 'README',
        text: c.text,
        embedText: `${repoName}: ${c.text}`,
        start: c.start,
        end: c.end,
      });
    }
  }

  const capped = chunks.slice(0, Math.max(1, maxChunks));
  const repoText = [description, uniqueStack.join(' '), readme].filter(Boolean).join('\n');
  return { chunks: capped, repoText };
}

/**
 * Scores one repository against the job requirements.
 *
 * @param {object} params
 * @param {Array<{text:string, importance:'must'|'nice', keywords:string[]}>} params.requirements
 * @param {number[][]} params.requirementVectors - one embedding per requirement (same order)
 * @param {Array<{chunk:object, vector:number[]}>} params.chunkItems
 * @param {string} params.repoText - full searchable text of the repository (for keyword presence)
 * @param {{lo?:number, hi?:number, matchThreshold?:number, maxMatches?:number}} [options]
 * @returns {{ score:number, semanticScore:number, keywordScore:number|null, matched:Array<object>, unmatchedRequirements:number }}
 */
function scoreRepo({
  requirements,
  requirementVectors,
  chunkItems,
  repoText,
  lo = DEFAULT_LO,
  hi = DEFAULT_HI,
  matchThreshold = DEFAULT_MATCH_THRESHOLD,
  maxMatches = 4,
}) {
  const reqs = Array.isArray(requirements) ? requirements : [];
  const items = Array.isArray(chunkItems) ? chunkItems : [];

  let semanticSum = 0;
  let weightSum = 0;
  let keywordSum = 0;
  let keywordWeightSum = 0;
  const matches = [];
  let unmatched = 0;

  reqs.forEach((req, i) => {
    const w = IMPORTANCE_WEIGHT[req.importance] ?? IMPORTANCE_WEIGHT.nice;
    weightSum += w;

    let best = { cosine: 0, chunk: null };
    const rv = requirementVectors && requirementVectors[i];
    if (rv) {
      for (const item of items) {
        const cos = cosineSimilarity(rv, item.vector);
        if (cos > best.cosine) best = { cosine: cos, chunk: item.chunk };
      }
    }
    semanticSum += w * scaleSimilarity(best.cosine, lo, hi);

    if (best.chunk && best.cosine >= matchThreshold) {
      matches.push({
        requirement: req.text,
        importance: req.importance,
        cosine: Math.round(best.cosine * 10000) / 10000,
        source: best.chunk.source,
        snippet: String(best.chunk.text).slice(0, 220),
      });
    } else {
      unmatched += 1;
    }

    const keywords = Array.isArray(req.keywords) ? req.keywords.filter(Boolean) : [];
    if (keywords.length > 0) {
      keywordWeightSum += w;
      if (keywords.some((k) => containsTerm(repoText, k))) keywordSum += w;
    }
  });

  const semanticScore = weightSum > 0 ? semanticSum / weightSum : 0;
  const keywordScore = keywordWeightSum > 0 ? keywordSum / keywordWeightSum : null;
  const score =
    keywordScore === null ? semanticScore : SEMANTIC_WEIGHT * semanticScore + KEYWORD_WEIGHT * keywordScore;

  matches.sort((a, b) => b.cosine - a.cosine);

  return {
    score: Math.round(score * 10000) / 10000,
    semanticScore: Math.round(semanticScore * 10000) / 10000,
    keywordScore: keywordScore === null ? null : Math.round(keywordScore * 10000) / 10000,
    matched: matches.slice(0, maxMatches),
    unmatchedRequirements: unmatched,
  };
}

/**
 * Human-readable band for a score. Raw scores are small on this embedding model (a strong repository
 * scored 0.37 to 0.61 in calibration, unrelated ones 0.10 to 0.17), so a percentage would mislead.
 *
 * @param {number|null} score
 * @returns {'strong'|'partial'|'weak'}
 */
function matchLevel(score) {
  if (score >= 0.35) return 'strong';
  if (score >= 0.18) return 'partial';
  return 'weak';
}

/**
 * Orders scored repositories (highest score first; ties: most recently pushed, then name) and
 * assigns ranks starting at 1. Returns new objects; the input is not mutated.
 */
function rankRepos(entries) {
  const list = Array.isArray(entries) ? entries.map((e) => ({ ...e })) : [];
  list.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const pa = a.pushedAt ? new Date(a.pushedAt).getTime() : 0;
    const pb = b.pushedAt ? new Date(b.pushedAt).getTime() : 0;
    if (pb !== pa) return pb - pa;
    return String(a.fullName).localeCompare(String(b.fullName));
  });
  list.forEach((e, idx) => {
    e.rank = idx + 1;
  });
  return list;
}

module.exports = {
  MAX_CHUNKS_PER_REPO,
  containsTerm,
  buildRepoChunks,
  scoreRepo,
  matchLevel,
  rankRepos,
};
