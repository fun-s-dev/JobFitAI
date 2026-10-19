const { getEffectiveStatus } = require('./effectiveStatus');

/**
 * Evaluates draft bullets against verified/approved claims.
 * A bullet is included ONLY IF every claim attached to it has effective status 'verified' or 'approved'.
 * If any claim attached to a bullet has effective status 'needs_review' or 'rejected',
 * the entire bullet is excluded.
 *
 * @param {object} draft - ResumeDraft object containing experience and projects
 * @param {Array<object>} claims - Array of claim records
 * @returns {{
 *   allowedBulletIds: string[],
 *   excludedBulletIds: string[],
 *   excludedBullets: Array<{ bulletId: string, bulletText: string, reasons: string[] }>
 * }}
 */
function filterGroundedDraft(draft = {}, claims = []) {
  // Map claims by bulletId
  const claimsByBulletId = new Map();
  for (const claim of claims) {
    if (!claim || !claim.bulletId) continue;
    const list = claimsByBulletId.get(claim.bulletId) || [];
    list.push(claim);
    claimsByBulletId.set(claim.bulletId, list);
  }

  // Extract all bullets from draft
  const allBullets = [];
  if (Array.isArray(draft.experience)) {
    for (const exp of draft.experience) {
      if (Array.isArray(exp.bullets)) {
        for (const b of exp.bullets) {
          if (b && b.id) {
            allBullets.push({ id: b.id, text: b.text || '' });
          }
        }
      }
    }
  }

  if (Array.isArray(draft.projects)) {
    for (const prj of draft.projects) {
      if (Array.isArray(prj.bullets)) {
        for (const b of prj.bullets) {
          if (b && b.id) {
            allBullets.push({ id: b.id, text: b.text || '' });
          }
        }
      }
    }
  }

  const allowedBulletIds = [];
  const excludedBulletIds = [];
  const excludedBullets = [];

  for (const bullet of allBullets) {
    const bulletClaims = claimsByBulletId.get(bullet.id) || [];

    const reasons = [];
    let isAllowed = true;

    if (bulletClaims.length === 0) {
      isAllowed = false;
      reasons.push('not verified');
    } else {
      for (const claim of bulletClaims) {
        const effective = getEffectiveStatus(claim);
        if (effective !== 'verified' && effective !== 'approved') {
          isAllowed = false;
          reasons.push(
            `Claim "${claim.claimText}" has effective status '${effective}' (automated: '${claim.status}'${
              claim.userOverride ? `, override: '${claim.userOverride.decision}'` : ''
            })`
          );
        }
      }
    }

    if (isAllowed) {
      allowedBulletIds.push(bullet.id);
    } else {
      excludedBulletIds.push(bullet.id);
      excludedBullets.push({
        bulletId: bullet.id,
        bulletText: bullet.text,
        reasons,
      });
    }
  }

  return {
    allowedBulletIds,
    excludedBulletIds,
    excludedBullets,
  };
}

module.exports = {
  getEffectiveStatus,
  filterGroundedDraft,
};
