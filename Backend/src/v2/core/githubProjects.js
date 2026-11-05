/**
 * Pure helpers for resume projects that are written from a GitHub repository.
 *
 * A GitHub project is built in three steps: (1) pick the repository passages most relevant to the job
 * (retrieval), (2) let the model write a few bullets from ONLY those passages, citing them,
 * (3) keep only bullets that cite real passages. Verification later checks each bullet against the same
 * repository, and export requires the user to confirm they built the project.
 */
const { cosineSimilarity } = require('./cosineSimilarity');

const MAX_BULLET_CHARS = 320;
// Candidates written per project. More are written than exported because verification drops bullets
// it cannot support; the export keeps at most MAX_EXPORTED_BULLETS_PER_PROJECT of the survivors.
const MAX_BULLETS_PER_PROJECT = 5;
const MAX_EXPORTED_BULLETS_PER_PROJECT = 4;
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
  maxReadmeChunks = 8,
  minCosine = 0.8,
  minReadmeChunks = 6,
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

const REPO_FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LOW_VALUE_LANGUAGES = new Set(['html', 'css', 'scss', 'sass', 'less', 'dockerfile', 'makefile', 'shell', 'batchfile', 'procfile']);

/** `https://github.com/owner/repo` for a valid "owner/repo", else null. */
function githubRepoUrl(repositoryFullName) {
  const name = String(repositoryFullName || '').trim();
  return REPO_FULL_NAME.test(name) ? `https://github.com/${name}` : null;
}

/** "owner/repo" from a github.com repository URL, else ''. */
function repoFullNameFromUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.hostname.toLowerCase() !== 'github.com') return '';
    const parts = u.pathname.split('/').filter(Boolean);
    return parts.length >= 2 ? `${parts[0]}/${parts[1].replace(/\.git$/, '')}` : '';
  } catch {
    return '';
  }
}

/**
 * The technologies of a repository, derived from its OWN code evidence (never from the model):
 * the main programming language, then the skills of its dependencies, then strong code evidence.
 *
 * @param {object} analysis GithubAnalysis (plain or lean)
 * @returns {string[]} up to `max` distinct names
 */
function deriveTechStack(analysis, { max = 7 } = {}) {
  const out = [];
  const seen = new Set();
  const add = (value) => {
    const s = String(value || '').trim();
    if (!s || s.length > 40) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };

  // Capabilities ("Password Hashing", "Unit Testing") are real but read poorly as a technology list, so
  // frameworks and tools come first and these only fill remaining space.
  const CAPABILITY = /hashing|testing|authentication$/i;
  const capabilities = [];
  const addTech = (value) => {
    if (CAPABILITY.test(String(value || ''))) capabilities.push(value);
    else add(value);
  };

  const languages = analysis && analysis.languages && typeof analysis.languages === 'object' ? analysis.languages : {};
  const mainLanguage = Object.entries(languages)
    .filter(([name]) => !LOW_VALUE_LANGUAGES.has(name.toLowerCase()))
    .sort((a, b) => Number(b[1]) - Number(a[1]))[0];
  if (mainLanguage) add(mainLanguage[0]);

  for (const dep of Array.isArray(analysis && analysis.dependencies) ? analysis.dependencies : []) {
    for (const skill of Array.isArray(dep && dep.skills) ? dep.skills : []) addTech(skill);
  }

  const strong = (Array.isArray(analysis && analysis.evidenceItems) ? analysis.evidenceItems : [])
    .filter((e) => e && !e.contradiction && Number(e.strength) >= 0.5)
    .sort((a, b) => Number(b.strength) - Number(a.strength));
  for (const e of strong) addTech(e.skill);

  for (const c of capabilities) add(c);
  return out.slice(0, max);
}

/**
 * Applies the project-related export rules to an already grounded export:
 *
 *  - GitHub-written projects are exported only after the user confirmed "I built this project".
 *  - The name shown is the user's chosen name, for ANY project tied to one of their repositories
 *    (a GitHub-written project by its analysis id, a resume project by its assigned/matching name).
 *  - A project tied to a verified repository shows a link to that repository.
 *
 * @param {object} params
 * @param {object} params.draft          the verified draft (plain object)
 * @param {object} params.exportDraft    the grounded export built from it
 * @param {Array<object>} params.links   ReportProjectLink records ({analysisId, repoUrl, displayName, projectName,
 *                                       control, authorshipConfirmedAt})
 * @returns {{ exportDraft: object, excludedItems: Array<{section:string, text:string, reason:string}> }}
 */
function applyGithubProjectRules({ draft, exportDraft, links }) {
  const { resolveProjectForRepo } = require('./projectMatching');
  const draftProjects = Array.isArray(draft && draft.projects) ? draft.projects : [];
  const allLinks = Array.isArray(links) ? links : [];
  const byAnalysis = new Map(allLinks.map((l) => [String(l.analysisId), l]));

  const hidden = new Set();
  const names = new Map();
  const urls = new Map();
  const excludedItems = [];

  // 1. Projects written from a repository: bound by analysis id, gated by the confirmation
  for (const prj of draftProjects) {
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
      continue;
    }
    names.set(prj.id, name);
    const url = githubRepoUrl(prj.repoFullName) || link.repoUrl;
    if (url) urls.set(prj.id, url);
  }

  // 2. Resume projects tied to a verified repository (by the user's choice, else by matching name)
  const claimed = new Set();
  for (const link of allLinks) {
    if (!link || !link.control || link.control.verified !== true) continue;
    if (link.analysisId && draftProjects.some((p) => p && p.source === 'github' && String(p.analysisId) === String(link.analysisId))) continue;
    const { index } = resolveProjectForRepo({
      explicitProjectName: link.projectName || null,
      repositoryFullName: repoFullNameFromUrl(link.repoUrl),
      projects: draftProjects,
    });
    if (index < 0) continue;
    const prj = draftProjects[index];
    if (!prj || prj.source === 'github' || claimed.has(prj.id)) continue;
    claimed.add(prj.id);
    if (link.displayName) names.set(prj.id, link.displayName);
    const url = safeRepoUrl(link.repoUrl);
    if (url) urls.set(prj.id, url);
  }

  const githubProjectIds = new Set(draftProjects.filter((p) => p && p.source === 'github').map((p) => p.id));
  const techById = new Map(draftProjects.filter((p) => p && Array.isArray(p.tech)).map((p) => [p.id, p.tech]));
  const projects = (exportDraft.projects || [])
    .filter((p) => !hidden.has(p.id))
    .map((p) => ({
      ...p,
      ...(names.has(p.id) ? { name: names.get(p.id) } : {}),
      ...(urls.has(p.id) ? { url: urls.get(p.id) } : {}),
      ...(p.tech === undefined && techById.has(p.id) ? { tech: techById.get(p.id) } : {}),
    }))
    .map((p) =>
      githubProjectIds.has(p.id) && Array.isArray(p.bullets)
        ? { ...p, bullets: p.bullets.slice(0, MAX_EXPORTED_BULLETS_PER_PROJECT) }
        : p
    );

  return { exportDraft: { ...exportDraft, projects }, excludedItems };
}

/** A github.com repository URL as stored on a link, or null. */
function safeRepoUrl(url) {
  const full = repoFullNameFromUrl(url);
  return full ? githubRepoUrl(full) : null;
}

module.exports = {
  MAX_BULLET_CHARS,
  MAX_BULLETS_PER_PROJECT,
  MAX_EXPORTED_BULLETS_PER_PROJECT,
  MAX_DISPLAY_NAME_CHARS,
  defaultProjectName,
  sanitizeDisplayName,
  githubRepoUrl,
  repoFullNameFromUrl,
  deriveTechStack,
  selectEvidencePack,
  sanitizeBullets,
  applyGithubProjectRules,
};
