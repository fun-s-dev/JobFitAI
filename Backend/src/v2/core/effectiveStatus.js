/**
 * Pure helper function to compute the effective status of a claim.
 * User decision in userOverride takes precedence over the automated status.
 *
 * effectiveStatus = userOverride?.decision ?? status
 *
 * @param {object} claim
 * @param {string} [claim.status] - Automated verdict ('verified' | 'needs_review' | 'rejected')
 * @param {object|null} [claim.userOverride] - User decision override { decision: 'approved' | 'rejected' }
 * @returns {string} The effective status
 */
function getEffectiveStatus(claim) {
  if (!claim || typeof claim !== 'object') {
    return 'rejected';
  }

  if (claim.userOverride && typeof claim.userOverride.decision === 'string') {
    return claim.userOverride.decision;
  }

  return claim.status || 'rejected';
}

module.exports = {
  getEffectiveStatus,
};
