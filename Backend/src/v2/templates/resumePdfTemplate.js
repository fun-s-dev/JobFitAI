/**
 * Escapes characters with HTML entities to prevent XSS / HTML injection
 * when rendering candidate-provided data into Chromium.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders a ResumeDraft into deterministic, ATS-friendly HTML.
 * Supports surgical bullet omission via excludedBulletIds.
 *
 * @param {object} draft - Validated ResumeDraft
 * @param {object} [options]
 * @param {string[]} [options.excludedBulletIds]
 * @returns {string} Plain HTML document
 */
function renderDraftToHtml(draft = {}, { excludedBulletIds = [] } = {}) {
  const excludedSet = new Set(excludedBulletIds);
  const summary = escapeHtml(draft.summary || '');
  const skills = Array.isArray(draft.skills) ? draft.skills : [];
  const experience = Array.isArray(draft.experience) ? draft.experience : [];
  const projects = Array.isArray(draft.projects) ? draft.projects : [];
  const education = Array.isArray(draft.education) ? draft.education : [];

  const experienceHtml = experience
    .map((exp) => {
      const remainingBullets = (exp.bullets || []).filter((b) => !excludedSet.has(b.id));
      if (remainingBullets.length === 0) return '';

      const bulletsList = remainingBullets
        .map(
          (b) =>
            `<li data-bullet-id="${escapeHtml(b.id)}" id="bullet-${escapeHtml(b.id)}">${escapeHtml(b.text)}</li>`
        )
        .join('\n');

      return `
        <div class="entry" data-entry-id="${escapeHtml(exp.id)}">
          <div class="entry-header">
            <span class="entry-title"><strong>${escapeHtml(exp.role)}</strong> — ${escapeHtml(exp.company)}</span>
            <span class="entry-dates">${escapeHtml(exp.dates || '')}</span>
          </div>
          <ul class="bullets">
            ${bulletsList}
          </ul>
        </div>
      `;
    })
    .filter(Boolean)
    .join('\n');

  const projectsHtml = projects
    .map((prj) => {
      const remainingBullets = (prj.bullets || []).filter((b) => !excludedSet.has(b.id));
      if (remainingBullets.length === 0) return '';

      const bulletsList = remainingBullets
        .map(
          (b) =>
            `<li data-bullet-id="${escapeHtml(b.id)}" id="bullet-${escapeHtml(b.id)}">${escapeHtml(b.text)}</li>`
        )
        .join('\n');

      return `
        <div class="entry" data-entry-id="${escapeHtml(prj.id)}">
          <div class="entry-header">
            <span class="entry-title"><strong>${escapeHtml(prj.name)}</strong></span>
          </div>
          <ul class="bullets">
            ${bulletsList}
          </ul>
        </div>
      `;
    })
    .filter(Boolean)
    .join('\n');

  const skillsHtml =
    skills.length > 0
      ? `<p class="skills-list">${skills.map(escapeHtml).join(' &bull; ')}</p>`
      : '';

  const educationHtml = education
    .map(
      (edu) => `
      <div class="entry" data-entry-id="${escapeHtml(edu.id)}">
        <div class="entry-header">
          <span class="entry-title"><strong>${escapeHtml(edu.degree)}</strong> — ${escapeHtml(edu.school)}</span>
          <span class="entry-dates">${escapeHtml(edu.dates || '')}</span>
        </div>
      </div>
    `
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Resume</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 10.5pt;
      line-height: 1.4;
      color: #111;
      background: #fff;
      padding: 0;
      margin: 0;
    }
    h2 {
      font-size: 12pt;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-bottom: 1px solid #333;
      padding-bottom: 2px;
      margin-top: 14px;
      margin-bottom: 6px;
    }
    .summary-text { margin-bottom: 8px; }
    .entry { margin-bottom: 8px; }
    .entry-header { display: flex; justify-content: space-between; margin-bottom: 2px; }
    .entry-title { font-size: 10.5pt; }
    .entry-dates { font-size: 10pt; color: #555; }
    .bullets { margin-left: 20px; margin-top: 3px; }
    .bullets li { margin-bottom: 3px; }
    .skills-list { font-size: 10pt; line-height: 1.5; }
  </style>
</head>
<body>
  ${summary ? `<section class="section"><h2>Professional Summary</h2><p class="summary-text">${summary}</p></section>` : ''}
  ${experienceHtml ? `<section class="section"><h2>Experience</h2>${experienceHtml}</section>` : ''}
  ${projectsHtml ? `<section class="section"><h2>Projects</h2>${projectsHtml}</section>` : ''}
  ${skillsHtml ? `<section class="section"><h2>Technical Skills</h2>${skillsHtml}</section>` : ''}
  ${educationHtml ? `<section class="section"><h2>Education</h2>${educationHtml}</section>` : ''}
</body>
</html>`;
}

module.exports = {
  escapeHtml,
  renderDraftToHtml,
};
