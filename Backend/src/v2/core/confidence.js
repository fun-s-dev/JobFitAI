const { getCfg } = require('../config/env');

/**
 * Pure function: calculates confidence score from available signals and config weights.
 *
 * Signals must be scaled between 0 and 1.
 * - With project signal: uses W_SIM / W_ENT / W_PROJ.
 * - Without (or when projectEvidenceScore is null/undefined): uses W_SIM_NOGH / W_ENT_NOGH.
 * Re-normalizes weights over the signals that apply so that null (inapplicable) signals
 * do not penalize the score as zero.
 *
 * @param {object} signals
 * @param {number|null} [signals.similarityScore]
 * @param {number|null} [signals.entailmentScore]
 * @param {number|null} [signals.projectEvidenceScore]
 * @param {object} [weightOverrides]
 * @returns {number} Confidence score in [0, 1] rounded to 4 decimal places
 */
function calculateConfidence(
  { similarityScore = null, entailmentScore = null, projectEvidenceScore = null } = {},
  weightOverrides
) {
  let cfg = weightOverrides;
  if (!cfg) {
    try {
      cfg = getCfg();
    } catch {
      cfg = {};
    }
  }

  const hasProject = projectEvidenceScore !== null && projectEvidenceScore !== undefined;

  const wSim = typeof cfg.W_SIM === 'number' ? cfg.W_SIM : 0.30;
  const wEnt = typeof cfg.W_ENT === 'number' ? cfg.W_ENT : 0.40;
  const wProj = typeof cfg.W_PROJ === 'number' ? cfg.W_PROJ : 0.30;

  const wSimNoGh = typeof cfg.W_SIM_NOGH === 'number' ? cfg.W_SIM_NOGH : 0.40;
  const wEntNoGh = typeof cfg.W_ENT_NOGH === 'number' ? cfg.W_ENT_NOGH : 0.60;

  // Determine base weights depending on whether project evidence is present
  const baseWeights = hasProject
    ? { sim: wSim, ent: wEnt, proj: wProj }
    : { sim: wSimNoGh, ent: wEntNoGh, proj: 0 };

  const activeSignals = [];

  if (similarityScore !== null && similarityScore !== undefined) {
    activeSignals.push({
      name: 'sim',
      val: Math.max(0, Math.min(1, Number(similarityScore))),
      weight: baseWeights.sim,
    });
  }

  if (entailmentScore !== null && entailmentScore !== undefined) {
    activeSignals.push({
      name: 'ent',
      val: Math.max(0, Math.min(1, Number(entailmentScore))),
      weight: baseWeights.ent,
    });
  }

  if (hasProject) {
    activeSignals.push({
      name: 'proj',
      val: Math.max(0, Math.min(1, Number(projectEvidenceScore))),
      weight: baseWeights.proj,
    });
  }

  const totalActiveWeight = activeSignals.reduce((sum, s) => sum + s.weight, 0);

  if (totalActiveWeight <= 0) {
    return 0;
  }

  // Calculate weighted sum re-normalized over active weights
  let rawScore = 0;
  for (const signal of activeSignals) {
    const normalizedWeight = signal.weight / totalActiveWeight;
    rawScore += normalizedWeight * signal.val;
  }

  const clamped = Math.max(0, Math.min(1, rawScore));
  return Math.round(clamped * 10000) / 10000;
}

module.exports = {
  calculateConfidence,
};
