/**
 * Pure helpers for resume projects that are written from a GitHub repository.
 *
 * A GitHub project is built in three steps: (1) pick the repository passages most relevant to the job
 * (retrieval), (2) let the model write a few bullets from ONLY those passages, citing them,
 * (3) keep only bullets that cite real passages. Verification later checks each bullet against the same
 * repository, and export requires the user to confirm they built the project.
 */
const { cosineSimilarity } = require('./cosineSimilarity');

const MAX_BULLET_CHARS = 300;
const MAX_BULLETS_PER_PROJECT = 3;
const MAX_DISPLAY_NAME_CHARS = 100;

/** "Banking-System-backend" -> "Banking System Backend". Used until the user edits the name. */
function defaultProjectName(repositoryFullName) {
  const repo = String(repositoryFullName || '').split('/').pop() || '';
  const words = repo
    .replace(/[-_.]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return 'Project';
  return words.map((w) => (w === w.toUpperCase() && w.length > 1 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

/** Cleans a user-entered project name: no control characters, single spaces, bounded length. */
function sanitizeDisplayName(value) {
  // eslint-disable-next-line no-control-regex
  const cleaned = String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, MAX_DISPLAY_NAME_CHARS);
}

/**
 * Chooses the repository passages the model may write from.
 *
 * - For each job requirement, the best `perRequirement` README passages at or above `minCosine`.
 * - The repository description and technology stack are always included (they state what the project is).
 * - The pack is topped up with the next best-matching README passages to at least minReadmeChunks, so the
 *   model has enough of the project to write from (the job's requirements alone would leave out strong
 *   content such as design decisions). A project with no relevant passage is still described, not skipped.
 *
 * @param {object} params
 * @param {Array<object>} params.requirements
 * @param {number[][]} params.requirementVectors
 * @param {Array<{chunk: {id:string, source:string, text:string}, vector:number[]}>} params.chunkItems
 * @returns {Array<{id:string, source:string, text:string}>} chunks in a stable order: description, README, stack
 */
function selectEvidencePack({
  requirements,
  requirementVectors,
  chunkItems,
  perRequirement = 2,
  maxReadmeChunks = 6,
  minCosine = 0.8,
  minReadmeChunks = 4,
}) {
  const items = Array.isArray(chunkItems) ? chunkItems : [];
  const readme = items.filter((it) => it.chunk.source === 'readme');
  const best = new Map(); // chunk id -> best cosine against any requirement

  (requirements || []).forEach((_, i) => {
    const rv = requirementVectors && requirementVectors[i];
    if (!rv) return;
    readme
      .map((it) => ({ it, cos: cosineSimilarity(rv, it.vector) }))
      .sort((a, b) => b.cos - a.cos)
      .slice(0, perRequirement)
      .filter((x) => x.cos >= minCosine)
      .forEach((x) => best.set(x.it.chunk.id, Math.max(best.get(x.it.chunk.id) || 0, x.cos)));
  });

  let chosen = readme
    .filter((it) => best.has(it.chunk.id))
    .sort((a, b) => best.get(b.chunk.id) - best.get(a.chunk.id))
    .slice(0, maxReadmeChunks);

  if (chosen.length < minReadmeChunks) {
    // Top up with the next best-matching passages (README order breaks ties, so the opening comes first)
    const taken = new Set(chosen.map((it) => it.chunk.id));
    const rest = readme
      .filter((it) => !taken.has(it.chunk.id))
      .map((it, order) => ({
        it,
        order,
        cos: Math.max(0, ...(requirementVectors || []).map((rv) => cosineSimilarity(rv, it.vector))),
      }))
      .sort((a, b) => b.cos - a.cos || a.order - b.order)
      .slice(0, minReadmeChunks - chosen.length)
      .map((x) => x.it);
    chosen = [...chosen, ...rest];
  }

  const metadata = items.filter((it) => it.chunk.source === 'metadata').slice(0, 1);
  const stack = items.filter((it) => it.chunk.source === 'dependencies').slice(0, 1);
  return [...metadata, ...chosen, ...stack].map((it) => it.chunk);
}

/**
 * Keeps only usable bullets: non-empty, bounded length, no duplicates, and citing at least one
 * passage that really exists in the evidence pack. Citations are mapped from the labels the model saw
 * (E1, E2, ...) to the real chunk ids.
 *
 * @param {Array<{text: string, evidence: string[]}>} bullets raw model output
 * @param {Map<string, {id: string}>} labelToChunk e.g. 'E1' -> chunk
 * @returns {Array<{text: string, sources: string[]}>}
 */
function sanitizeBullets(bullets, labelToChunk) {
  const out = [];
  const seen = new Set();
  for (const b of Array.isArray(bullets) ? bullets : []) {
    const text = String((b && b.text) || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > MAX_BULLET_CHARS) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    const sources = [
      ...new Set(
        (Array.isArray(b.evidence) ? b.evidence : [])
          .map((label) => labelToChunk.get(String(label).trim().toUpperCase()))
          .filter(Boolean)
          .map((chunk) => chunk.id)
      ),
    ];
    if (sources.length === 0) continue; // an uncited bullet cannot be traced to the repository
    seen.add(key);
    out.push({ text, sources });
    if (out.length >= MAX_BULLETS_PER_PROJECT) break;
  }
  return out;
}

/**
 * Applies the GitHub-project rules to an already grounded export:
 *  - the project is only exported after the user confirmed "I built this project"
 *  - the name shown is the user's chosen name, if any
 *
 * @param {object} params
 * @param {object} params.draft          the verified draft (plain object)
 * @param {object} params.exportDraft    the grounded export built from it
 * @param {Array<{analysisId: *, displayName?: string|null, authorshipConfirmedAt?: Date|null}>} params.links
 * @returns {{ exportDraft: object, excludedItems: Array<{section:string, text:string, reason:string}> }}
 */
function applyGithubProjectRules({ draft, exportDraft, links }) {
  const byAnalysis = new Map((links || []).map((l) => [String(l.analysisId), l]));
  const hidden = new Set();
  const names = new Map();
  const excludedItems = [];

  for (const prj of Array.isArray(draft && draft.projects) ? draft.projects : []) {
    if (!prj || prj.source !== 'github' || !prj.analysisId) continue;
    const link = byAnalysis.get(String(prj.analysisId));
    const name = (link && link.displayName) || prj.name;
    if (!link || !link.authorshipConfirmedAt) {
      hidden.add(prj.id);
      excludedItems.push({
        section: 'projects',
        text: name,
        reason: `Confirm that you built "${name}" to include it. Owning a repository does not show that you wrote its code.`,
      });
    } else {
      names.set(prj.id, name);
    }
  }

  const projects = (exportDraft.projects || [])
    .filter((p) => !hidden.has(p.id))
    .map((p) => (names.has(p.id) ? { ...p, name: names.get(p.id) } : p));

  return { exportDraft: { ...exportDraft, projects }, excludedItems };
}

module.exports = {
  MAX_BULLET_CHARS,
  MAX_BULLETS_PER_PROJECT,
  MAX_DISPLAY_NAME_CHARS,
  defaultProjectName,
  sanitizeDisplayName,
  selectEvidencePack,
  sanitizeBullets,
  applyGithubProjectRules,
};
