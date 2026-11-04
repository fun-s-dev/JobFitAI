/**
 * Deterministic extraction of resume content that the AI draft tends to lose: profile and certificate
 * LINKS, the CERTIFICATIONS / ACHIEVEMENTS list, and the GRADE (CGPA) next to an education entry.
 *
 * Everything here is COPIED from the user's own resume, never written by a model, so it cannot be
 * invented. That is why it needs no claim verification: it is "grounded by construction".
 *
 * Input is the resume text extracted with hyperlinks as Markdown `[label](url)` (pdf-parse
 * `parseHyperlinks`). Pure module: no I/O.
 */
const { normalizeText } = require('./normalizeText');
const { tokenCoverage, buildEvidenceIndex } = require('./sectionGrounding');

// A label may contain one nested bracket pair, e.g. "[[Certificate]](https://...)"
const LINK_RE = /\[((?:[^[\]]|\[[^[\]]*\])+)\]\((https?:\/\/[^)\s]+)\)/g;

const PAGE_MARKER = /^-+\s*\d+\s+of\s+\d+\s*-+$/i;
const MAX_LINKS = 30;
const MAX_CERTIFICATIONS = 12;
const MAX_ITEM_CHARS = 400;
const MAX_LABEL_CHARS = 60;
const MAX_URL_CHARS = 300;

const SECTION_PATTERNS = [
  ['summary', /^(?:professional\s+)?summary$|^objective$|^profile$|^about(?:\s+me)?$/],
  ['experience', /^(?:work\s+|professional\s+)?experience$|^employment(?:\s+history)?$|^internships?$/],
  ['projects', /^(?:technical\s+|personal\s+|academic\s+)?projects$/],
  ['skills', /^(?:technical\s+)?skills$|^technologies$/],
  ['education', /^education$|^academics?$|^academic\s+background$/],
  ['certifications', /^(?:certifications?|certificates?|licenses?|achievements?|awards?|honou?rs|accomplishments)(?:\s*(?:and|&)\s*(?:certifications?|certificates?|achievements?|awards?|honou?rs|accomplishments))?$/],
];

/** Removes the Markdown of `[label](url)` and keeps the label. */
function stripMarkdownLinks(text) {
  return String(text || '').replace(LINK_RE, '$1');
}

/** Returns a normalized http(s) URL, or null for anything else (javascript:, data:, credentials, too long). */
function safeHttpUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    const out = url.toString();
    return out.length <= MAX_URL_CHARS ? out : null;
  } catch {
    return null;
  }
}

/** Which resume section a heading line starts, or null when the line is not a known heading. */
function detectSection(line) {
  const cleaned = stripMarkdownLinks(line).trim().replace(/[:\-_|]+$/g, '').trim().toLowerCase();
  if (!cleaned || cleaned.length > 50 || cleaned.startsWith('-')) return null;
  for (const [key, pattern] of SECTION_PATTERNS) {
    if (pattern.test(cleaned)) return key;
  }
  return null;
}

function linksInLine(line, section) {
  const out = [];
  const plain = stripMarkdownLinks(line).trim().slice(0, 200);
  for (const m of String(line).matchAll(LINK_RE)) {
    const url = safeHttpUrl(m[2]);
    const label = m[1].trim().slice(0, MAX_LABEL_CHARS);
    if (url && label) out.push({ label, url, section, line: plain });
  }
  return out;
}

const GRADE_RE =
  /\b(CGPA|SGPA|GPA|CPI|Percentage)\b\s*[:-]?\s*(\d{1,3}(?:\.\d{1,2})?)(\s*\/\s*\d{1,3}(?:\.\d{1,2})?)?\s*(\([^)]{1,40}\))?/i;

function formatGrade(match) {
  const label = match[1].toUpperCase() === 'PERCENTAGE' ? 'Percentage' : match[1].toUpperCase();
  const value = match[2];
  if (Number(value) > 100) return null;
  const scale = match[3] ? ` / ${match[3].replace(/[\s/]/g, '')}` : '';
  const note = match[4] ? ` ${match[4].trim()}` : '';
  return `${label}: ${value}${scale}${note}`;
}

/**
 * @param {string} linkedText resume text with `[label](url)` links (as produced by pdf-parse parseHyperlinks)
 * @returns {{
 *   version: 1,
 *   links: Array<{label:string, url:string, section:string, line:string}>,
 *   certifications: Array<{text:string, links:Array<{label:string,url:string}>}>,
 *   education: { lines: string[], grades: Array<{text:string, lineIndex:number}> }
 * }}
 */
function extractResumeExtras(linkedText) {
  const lines = normalizeText(String(linkedText || '')).split('\n');
  let section = 'header';
  const links = [];
  const certLines = [];
  const eduLines = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (PAGE_MARKER.test(line)) continue; // "-- 1 of 2 --" inserted by the PDF text extractor
    const heading = detectSection(line);
    if (heading) {
      section = heading;
      continue;
    }
    links.push(...linksInLine(line, section));
    if (section === 'certifications') certLines.push(line);
    if (section === 'education') eduLines.push(line);
  }

  // Certifications / achievements: one entry per bullet, wrapped lines joined to their bullet
  const hasBullets = certLines.some((l) => l.startsWith('-'));
  const items = [];
  for (const line of certLines) {
    if (!hasBullets || line.startsWith('-')) {
      items.push(line.replace(/^-\s*/, ''));
    } else if (items.length > 0) {
      items[items.length - 1] += ` ${line}`;
    } else {
      items.push(line);
    }
  }
  const certifications = items
    .slice(0, MAX_CERTIFICATIONS)
    .map((rawItem) => {
      const itemLinks = [];
      for (const m of rawItem.matchAll(LINK_RE)) {
        const url = safeHttpUrl(m[2]);
        const label = m[1].trim().slice(0, MAX_LABEL_CHARS);
        if (url && label) itemLinks.push({ label, url });
      }
      const text = stripMarkdownLinks(rawItem).replace(/\s+/g, ' ').trim().slice(0, MAX_ITEM_CHARS);
      return { text, links: itemLinks };
    })
    .filter((c) => c.text);

  // Grades next to the education entries
  const educationLines = eduLines.map((l) => stripMarkdownLinks(l).replace(/\s+/g, ' ').trim().slice(0, 200)).slice(0, 12);
  const grades = [];
  educationLines.forEach((line, lineIndex) => {
    const m = GRADE_RE.exec(line);
    const text = m ? formatGrade(m) : null;
    if (text) grades.push({ text, lineIndex });
  });

  return {
    version: 1,
    links: links.slice(0, MAX_LINKS),
    certifications,
    education: { lines: educationLines, grades },
  };
}

/**
 * Which education entry a grade belongs to: the entry whose school/degree words best match the lines
 * around the grade; with a single entry, that entry.
 */
function gradeForEntries(entries, education) {
  const result = new Map(); // entry id -> grade text
  const grades = (education && education.grades) || [];
  const lines = (education && education.lines) || [];
  if (!grades.length || !entries.length) return result;

  for (const grade of grades) {
    if (entries.length === 1) {
      if (!result.has(entries[0].id)) result.set(entries[0].id, grade.text);
      continue;
    }
    const near = lines.slice(Math.max(0, grade.lineIndex - 2), grade.lineIndex + 3).join(' ');
    const index = buildEvidenceIndex([near]);
    let best = null;
    for (const entry of entries) {
      const coverage = tokenCoverage(index, `${entry.school || ''} ${entry.degree || ''}`) ?? 0;
      if (coverage >= 0.3 && (!best || coverage > best.coverage)) best = { id: entry.id, coverage };
    }
    if (best && !result.has(best.id)) result.set(best.id, grade.text);
  }
  return result;
}

/**
 * Adds profile links, certifications and grades (all copied from the resume) to a grounded export draft.
 * Returns a new draft; with no extras the draft is returned unchanged.
 */
function applyResumeExtras({ exportDraft, extras }) {
  if (!extras || typeof extras !== 'object') return exportDraft;

  const seen = new Set();
  const headerLinks = [];
  for (const l of Array.isArray(extras.links) ? extras.links : []) {
    if (l.section !== 'header' || !safeHttpUrl(l.url) || seen.has(l.url)) continue;
    seen.add(l.url);
    headerLinks.push({ label: l.label, url: l.url });
  }

  const certifications = (Array.isArray(extras.certifications) ? extras.certifications : [])
    .filter((c) => c && typeof c.text === 'string' && c.text.trim())
    .map((c) => ({
      text: c.text,
      links: (Array.isArray(c.links) ? c.links : []).filter((l) => safeHttpUrl(l.url)).map((l) => ({ label: l.label, url: l.url })),
    }));

  const grades = gradeForEntries(exportDraft.education || [], extras.education);
  const education = (exportDraft.education || []).map((e) => (grades.has(e.id) ? { ...e, grade: grades.get(e.id) } : e));

  // A bare label such as "LinkedIn" in the contact lines is replaced by the real hyperlink, not repeated
  const linkLabels = new Set(headerLinks.map((l) => l.label.trim().toLowerCase()));
  const contact = (Array.isArray(exportDraft.contact) ? exportDraft.contact : []).filter(
    (c) => !linkLabels.has(String(c).trim().toLowerCase())
  );

  return { ...exportDraft, contact, links: headerLinks, certifications, education };
}

module.exports = {
  stripMarkdownLinks,
  safeHttpUrl,
  detectSection,
  extractResumeExtras,
  gradeForEntries,
  applyResumeExtras,
};
