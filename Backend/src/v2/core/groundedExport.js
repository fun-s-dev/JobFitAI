const { getEffectiveStatus } = require('./effectiveStatus');
const { groundDraftSections } = require('./sectionGrounding');

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

/**
 * Builds the complete grounded export for a draft:
 * - experience/project bullets filtered by claim status (filterGroundedDraft)
 * - header, skills, education filtered deterministically against the user's evidence
 * - summary always left out (not claim-checked)
 *
 * Returns `exportDraft`, a draft object containing ONLY the content that may be rendered.
 *
 * @param {object} draft - ResumeDraft content (plain object)
 * @param {Array<object>} claims - Claims of the verification run that verified THIS draft
 * @param {string[]} evidenceTexts - User-supplied evidence (resume text, self-description)
 */
function buildGroundedExport(draft = {}, claims = [], evidenceTexts = []) {
  const bulletResult = filterGroundedDraft(draft, claims);
  const sections = groundDraftSections(draft, evidenceTexts);
  const excluded = new Set(bulletResult.excludedBulletIds);
  const educationIds = new Set(sections.educationIds);

  const keepBullets = (bullets) =>
    (Array.isArray(bullets) ? bullets : [])
      .filter((b) => b && b.id && !excluded.has(b.id))
      .map((b) => ({ id: b.id, text: b.text }));

  const exportDraft = {
    name: sections.header.name,
    contact: sections.header.contact,
    summary: '',
    experience: (Array.isArray(draft.experience) ? draft.experience : [])
      .map((exp) => ({
        id: exp.id,
        company: exp.company,
        role: exp.role,
        dates: exp.dates || '',
        bullets: keepBullets(exp.bullets),
      }))
      .filter((exp) => exp.bullets.length > 0),
    projects: (Array.isArray(draft.projects) ? draft.projects : [])
      .map((prj) => ({ id: prj.id, name: prj.name, bullets: keepBullets(prj.bullets) }))
      .filter((prj) => prj.bullets.length > 0),
    skills: sections.skills,
    education: (Array.isArray(draft.education) ? draft.education : [])
      .filter((edu) => edu && educationIds.has(edu.id))
      .map((edu) => ({ id: edu.id, school: edu.school, degree: edu.degree, dates: edu.dates || '' })),
  };

  return {
    exportDraft,
    allowedBulletIds: bulletResult.allowedBulletIds,
    excludedBulletIds: bulletResult.excludedBulletIds,
    excludedBullets: bulletResult.excludedBullets,
    excludedItems: sections.excludedItems,
    warnings: sections.warnings,
  };
}

module.exports = {
  getEffectiveStatus,
  filterGroundedDraft,
  buildGroundedExport,
};
