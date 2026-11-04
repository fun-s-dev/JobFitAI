/**
 * Pure helpers that tie GitHub repository evidence to the draft project it belongs to.
 *
 * Why this exists: repository evidence used to be matched to a claim by SKILL keywords only, so a repo
 * could support a claim of a different project that merely used the same technology. Evidence now only
 * flows between a repository and the claims of the project that repository was matched to.
 */

/** Lowercase and keep letters/digits only: "Meri-Sakhi", "meri_sakhi" and "Meri Sakhi" become "merisakhi". */
function normalizeProjectKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Index of the draft project that a bullet id such as "prj2.b0" belongs to; null for non-project bullets. */
function projectIndexFromBulletId(bulletId) {
  const m = /^prj(\d+)\.b\d+$/.exec(String(bulletId || ''));
  return m ? Number(m[1]) : null;
}

/**
 * Automatic match by name. Exact normalized equality wins. Otherwise a project matches when one
 * normalized name contains the other (both at least 5 characters). An ambiguous result (several
 * projects match) is NOT guessed: it returns -1 so the user can choose.
 *
 * @param {string} repositoryFullName "owner/repo" (or just "repo")
 * @param {Array<{name: string}>} projects draft projects
 * @returns {number} project index or -1
 */
function autoMatchProjectIndex(repositoryFullName, projects) {
  const list = Array.isArray(projects) ? projects : [];
  const repoKey = normalizeProjectKey(String(repositoryFullName || '').split('/').pop());
  if (!repoKey) return -1;

  const exact = [];
  const partial = [];
  list.forEach((p, idx) => {
    const key = normalizeProjectKey(p && p.name);
    if (!key) return;
    if (key === repoKey) exact.push(idx);
    else if (key.length >= 5 && repoKey.length >= 5 && (key.includes(repoKey) || repoKey.includes(key))) {
      partial.push(idx);
    }
  });

  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return -1;
  if (partial.length === 1) return partial[0];
  return -1;
}

/**
 * Resolves which draft project a linked repository belongs to.
 * An explicit choice made by the user wins over the automatic name match. An explicit choice that no
 * longer exists in the draft is treated as unmatched (never silently re-guessed).
 *
 * @returns {{ index: number, source: 'user'|'name'|'none' }}
 */
function resolveProjectForRepo({ explicitProjectName = null, repositoryFullName, projects }) {
  const list = Array.isArray(projects) ? projects : [];
  if (explicitProjectName) {
    const wanted = normalizeProjectKey(explicitProjectName);
    const idx = list.findIndex((p) => normalizeProjectKey(p && p.name) === wanted);
    return idx >= 0 ? { index: idx, source: 'user' } : { index: -1, source: 'none' };
  }
  const auto = autoMatchProjectIndex(repositoryFullName, list);
  return auto >= 0 ? { index: auto, source: 'name' } : { index: -1, source: 'none' };
}

module.exports = {
  normalizeProjectKey,
  projectIndexFromBulletId,
  autoMatchProjectIndex,
  resolveProjectForRepo,
};
