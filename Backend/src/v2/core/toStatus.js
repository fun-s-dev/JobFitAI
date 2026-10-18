const { getCfg } = require('../config/env');

/**
 * Pure function: maps a numerical confidence score, guardrail caps, and optional verdict
 * to a tri-state status: 'verified' | 'needs_review' | 'rejected'.
 *
 * Rules:
 * - confidence >= t.verified -> 'verified'
 * - confidence >= t.review   -> 'needs_review'
 * - otherwise               -> 'rejected'
 * - caps.includes('needs_review') demotes 'verified' to 'needs_review'
 * - caps.includes('rejected') OR verdict === 'no' forces 'rejected'
 *
 * @param {number} confidence - Continuous confidence score in [0, 1]
 * @param {string[]} [caps=[]] - Guardrail caps (e.g. ['needs_review'], ['rejected'])
 * @param {object} [thresholds] - Cutoffs { verified, review }
 * @param {string|null} [verdict=null] - Entailment verdict ('yes' | 'partial' | 'no')
 * @returns {'verified'|'needs_review'|'rejected'}
 */
function toStatus(confidence, caps = [], thresholds, verdict = null) {
  let t = thresholds;
  if (!t || typeof t.verified !== 'number' || typeof t.review !== 'number') {
    try {
      const cfg = getCfg();
      t = {
        verified: typeof cfg.THRESHOLD_VERIFIED === 'number' ? cfg.THRESHOLD_VERIFIED : 0.80,
        review: typeof cfg.THRESHOLD_REVIEW === 'number' ? cfg.THRESHOLD_REVIEW : 0.50,
      };
    } catch {
      t = { verified: 0.80, review: 0.50 };
    }
  }

  const numConfidence = Number(confidence) || 0;
  let status =
    numConfidence >= t.verified
      ? 'verified'
      : numConfidence >= t.review
      ? 'needs_review'
      : 'rejected';

  const capList = Array.isArray(caps) ? caps : [];

  if (capList.includes('needs_review') && status === 'verified') {
    status = 'needs_review';
  }

  if (capList.includes('rejected') || verdict === 'no') {
    status = 'rejected';
  }

  return status;
}

module.exports = {
  toStatus,
};
