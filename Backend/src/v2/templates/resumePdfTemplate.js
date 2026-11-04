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
 * Only http(s) URLs may become links. Anything else (javascript:, data:, ...) is rendered as plain text.
 * @returns {string|null} the escaped URL, or null when it is not a safe web URL
 */
function safeHref(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    return escapeHtml(u.toString());
  } catch {
    return null;
  }
}

/** `<a>` for a safe URL (opens safely, no referrer), otherwise the plain escaped label. */
function linkHtml(label, url) {
  const href = safeHref(url);
  const text = escapeHtml(label);
  return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
}

function bulletsHtml(bullets, excludedSet) {
  return (bullets || [])
    .filter((b) => !excludedSet.has(b.id))
    .map(
      (b) =>
        `<li data-bullet-id="${escapeHtml(b.id)}" id="bullet-${escapeHtml(b.id)}">${escapeHtml(b.text)}</li>`
    )
    .join('\n');
}

/**
 * Renders a ResumeDraft into deterministic, ATS-friendly HTML.
 * Supports surgical bullet omission via excludedBulletIds.
 *
 * Optional export-only fields (all copied from the user's own material, see core/resumeExtras.js):
 *   draft.links           profile links shown under the name
 *   draft.certifications  certifications / achievements, each with optional links
 *   draft.education[].grade, draft.projects[].tech / .url
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
  const certifications = Array.isArray(draft.certifications) ? draft.certifications : [];
  const headerLinks = Array.isArray(draft.links) ? draft.links : [];

  const experienceHtml = experience
    .map((exp) => {
      const bulletsList = bulletsHtml(exp.bullets, excludedSet);
      if (!bulletsList) return '';

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
      const bulletsList = bulletsHtml(prj.bullets, excludedSet);
      if (!bulletsList) return '';

      const tech = (Array.isArray(prj.tech) ? prj.tech : []).filter((t) => typeof t === 'string' && t.trim());
      const techHtml = tech.length > 0 ? ` <span class="entry-tech">| ${tech.map(escapeHtml).join(', ')}</span>` : '';
      const linkPart = prj.url && safeHref(prj.url) ? `<span class="entry-link">${linkHtml('GitHub', prj.url)}</span>` : '';

      return `
        <div class="entry" data-entry-id="${escapeHtml(prj.id)}">
          <div class="entry-header">
            <span class="entry-title"><strong>${escapeHtml(prj.name)}</strong>${techHtml}</span>
            ${linkPart}
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

  const name = typeof draft.name === 'string' ? draft.name.trim() : '';
  const contactParts = [
    ...(Array.isArray(draft.contact) ? draft.contact : [])
      .filter((c) => typeof c === 'string' && c.trim())
      .map((c) => escapeHtml(c.trim())),
    ...headerLinks.filter((l) => l && l.label && l.url).map((l) => linkHtml(l.label, l.url)),
  ];
  const headerHtml =
    name || contactParts.length > 0
      ? `<header class="resume-header">
    ${name ? `<h1 class="resume-name">${escapeHtml(name)}</h1>` : ''}
    ${contactParts.length > 0 ? `<p class="resume-contact">${contactParts.join(' &nbsp;|&nbsp; ')}</p>` : ''}
  </header>`
      : '';

  const educationHtml = education
    .map(
      (edu) => `
      <div class="entry" data-entry-id="${escapeHtml(edu.id)}">
        <div class="entry-header">
          <span class="entry-title"><strong>${escapeHtml(edu.degree)}</strong> — ${escapeHtml(edu.school)}</span>
          <span class="entry-dates">${escapeHtml(edu.dates || '')}</span>
        </div>
        ${edu.grade ? `<div class="entry-sub">${escapeHtml(edu.grade)}</div>` : ''}
      </div>
    `
    )
    .join('\n');

  const certificationsHtml = certifications
    .filter((c) => c && typeof c.text === 'string' && c.text.trim())
    .map((c) => {
      const links = (Array.isArray(c.links) ? c.links : [])
        .filter((l) => l && l.label && l.url)
        .map((l) => linkHtml(l.label, l.url));
      // The resume text may already end with the link label (e.g. "[Certificate]"): show the link once
      let text = escapeHtml(c.text);
      for (const l of Array.isArray(c.links) ? c.links : []) {
        const label = escapeHtml(l.label || '');
        if (label && text.endsWith(label)) text = text.slice(0, -label.length).trimEnd();
      }
      return `<li>${text}${links.length > 0 ? ` ${links.join(' ')}` : ''}</li>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${name ? `${escapeHtml(name)} - Resume` : 'Resume'}</title>
  <style>
    @page { size: A4; margin: 18mm 15mm; }
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
    a { color: #1a4fa0; text-decoration: none; }
    h2 {
      font-size: 11.5pt;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      border-bottom: 1px solid #333;
      padding-bottom: 2px;
      margin-top: 13px;
      margin-bottom: 6px;
    }
    .summary-text { margin-bottom: 8px; }
    .entry { margin-bottom: 8px; page-break-inside: avoid; }
    .entry-header { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 2px; }
    .entry-title { font-size: 10.5pt; }
    .entry-tech { font-style: italic; color: #333; }
    .entry-dates, .entry-link { font-size: 10pt; color: #555; white-space: nowrap; }
    .entry-sub { font-size: 10pt; color: #333; }
    .bullets { margin-left: 20px; margin-top: 3px; }
    .bullets li { margin-bottom: 3px; }
    .cert-list { margin-left: 20px; }
    .cert-list li { margin-bottom: 3px; }
    .skills-list { font-size: 10pt; line-height: 1.5; }
    .resume-header { text-align: center; margin-bottom: 6px; }
    .resume-name { font-size: 19pt; letter-spacing: 0.6px; }
    .resume-contact { font-size: 10pt; color: #333; margin-top: 2px; }
    @media screen {
      body { max-width: 210mm; margin: 24px auto; padding: 20mm 15mm; box-shadow: 0 0 8px rgba(0,0,0,0.15); }
    }
  </style>
</head>
<body>
  ${headerHtml}
  ${summary ? `<section class="section"><h2>Professional Summary</h2><p class="summary-text">${summary}</p></section>` : ''}
  ${experienceHtml ? `<section class="section"><h2>Experience</h2>${experienceHtml}</section>` : ''}
  ${projectsHtml ? `<section class="section"><h2>Projects</h2>${projectsHtml}</section>` : ''}
  ${skillsHtml ? `<section class="section"><h2>Technical Skills</h2>${skillsHtml}</section>` : ''}
  ${educationHtml ? `<section class="section"><h2>Education</h2>${educationHtml}</section>` : ''}
  ${certificationsHtml ? `<section class="section"><h2>Certifications &amp; Achievements</h2><ul class="cert-list">${certificationsHtml}</ul></section>` : ''}
</body>
</html>`;
}

module.exports = {
  escapeHtml,
  safeHref,
  renderDraftToHtml,
};
