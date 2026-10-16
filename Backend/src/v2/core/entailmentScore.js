const { getCfg } = require('../config/env');

/**
 * Pure function mapping an entailment verdict to a continuous score between 0.0 and 1.0.
 *
 * Defaults:
 *   'yes'     -> 1.0
 *   'partial' -> 0.5
 *   'no'      -> 0.0
 *
 * @param {'yes'|'partial'|'no'|string} verdict
 * @param {object} [configOverride]
 * @returns {number}
 */
function toEntailmentScore(verdict, configOverride) {
  let cfg = configOverride;
  if (!cfg) {
    try {
      cfg = getCfg();
    } catch {
      cfg = {};
    }
  }

  const scoreYes = typeof cfg.ENTAILMENT_SCORE_YES === 'number' ? cfg.ENTAILMENT_SCORE_YES : 1.0;
  const scorePartial =
    typeof cfg.ENTAILMENT_SCORE_PARTIAL === 'number' ? cfg.ENTAILMENT_SCORE_PARTIAL : 0.5;
  const scoreNo = typeof cfg.ENTAILMENT_SCORE_NO === 'number' ? cfg.ENTAILMENT_SCORE_NO : 0.0;

  switch (verdict) {
    case 'yes':
      return scoreYes;
    case 'partial':
      return scorePartial;
    case 'no':
      return scoreNo;
    default:
      return 0.0;
  }
}

module.exports = {
  toEntailmentScore,
};
