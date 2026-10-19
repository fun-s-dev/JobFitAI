/**
 * Calculates the project evidence score for a claim from a collection of EvidenceItems.
 * Enforces independence classes:
 * - Contradictions are excluded from score calculation.
 * - Scores combine via best-strength + tiny bonus (0.05 per distinct artifact type), never a simple sum.
 * - Returns null when no skills or no relevant supporting items exist.
 *
 * @param {string[]} claimSkills - Normalized skills extracted from the claim
 * @param {Array<object>} items - Repository EvidenceItems
 * @returns {number|null} Score in [0, 1] rounded to 4 decimals, or null if not applicable
 */
function projectEvidenceScore(claimSkills, items) {
  if (!Array.isArray(claimSkills) || claimSkills.length === 0 || !Array.isArray(items) || items.length === 0) {
    return null;
  }

  const skillSet = new Set(claimSkills.map((s) => s.toLowerCase()));
  const relevant = items.filter(
    (item) => item.skill && skillSet.has(item.skill.toLowerCase()) && !item.contradiction
  );

  if (relevant.length === 0) {
    return null;
  }

  const best = Math.max(...relevant.map((i) => i.strength || 0));
  const distinctTypes = new Set(relevant.map((i) => i.type)).size;
  const rawScore = Math.min(1.0, best + 0.05 * (distinctTypes - 1));

  return Math.round(rawScore * 10000) / 10000;
}

/**
 * Aggregates project evidence items for a claim, surfacing evidence IDs and contradictions.
 *
 * @param {string[]} claimSkills
 * @param {Array<object>} items
 * @returns {{ score: number|null, evidenceItemIds: string[], contradictions: string[] }}
 */
function aggregateProjectEvidence(claimSkills, items) {
  if (!Array.isArray(claimSkills) || claimSkills.length === 0 || !Array.isArray(items) || items.length === 0) {
    return {
      score: null,
      evidenceItemIds: [],
      contradictions: [],
    };
  }

  const skillSet = new Set(claimSkills.map((s) => s.toLowerCase()));

  const relevant = [];
  const contradictions = [];

  for (const item of items) {
    if (!item.skill || !skillSet.has(item.skill.toLowerCase())) {
      continue;
    }

    if (item.contradiction) {
      contradictions.push(item.claimSupport || `Contradiction detected for ${item.skill}`);
    } else {
      relevant.push(item);
    }
  }

  let score = null;
  if (relevant.length > 0) {
    const best = Math.max(...relevant.map((i) => i.strength || 0));
    const distinctTypes = new Set(relevant.map((i) => i.type)).size;
    const rawScore = Math.min(1.0, best + 0.05 * (distinctTypes - 1));
    score = Math.round(rawScore * 10000) / 10000;
  }

  const evidenceItemIds = relevant
    .map((i) => (i._id ? String(i._id) : null))
    .filter(Boolean);

  return {
    score,
    evidenceItemIds,
    contradictions,
  };
}

module.exports = {
  projectEvidenceScore,
  aggregateProjectEvidence,
};
