const defaultAliases = require('../data/skillAliases.json');
const { normalizeSkill } = require('./skillNormalizer');

/**
 * Deterministic grounding for the parts of a ResumeDraft that are NOT checked
 * claim-by-claim (header, skills, education, entry headers, summary).
 *
 * "Grounded" here means: the text appears in the evidence the user supplied
 * (resume text + self-description). This is a consistency check against the
 * user's own material, NOT independent factual verification.
 *
 * Pure module: no I/O.
 */

const STOPWORDS = new Set(['and', 'the', 'for', 'with', 'from', 'into', 'onto']);
const MIN_TOKEN_LENGTH = 3;

/**
 * Lowercases, applies NFKC, and collapses everything except [a-z0-9+#] to single spaces.
 * Keeps "+" and "#" so "C++" and "C#" stay distinct from "C".
 */
function normalizeForMatch(text) {
  if (typeof text !== 'string') return '';
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim();
}

/**
 * @param {string[]} texts
 * @returns {{ padded: string, tokens: Set<string> }}
 */
function buildEvidenceIndex(texts = []) {
  const joined = (Array.isArray(texts) ? texts : [texts])
    .filter((t) => typeof t === 'string' && t.trim())
    .map(normalizeForMatch)
    .filter(Boolean)
    .join(' ');
  return {
    padded: ` ${joined} `,
    tokens: new Set(joined.split(' ').filter(Boolean)),
  };
}

/** Whole-phrase match on token boundaries. */
function containsPhrase(index, phrase) {
  const p = normalizeForMatch(phrase);
  if (!p) return false;
  return index.padded.includes(` ${p} `);
}

function significantTokens(text) {
  return normalizeForMatch(text)
    .split(' ')
    .filter((t) => t.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(t));
}

/**
 * Fraction of significant tokens of `text` present in the evidence.
 * Returns null when the text has no significant tokens (e.g. "BS", "CS").
 */
function tokenCoverage(index, text) {
  const tokens = significantTokens(text);
  if (tokens.length === 0) return null;
  const found = tokens.filter((t) => index.tokens.has(t)).length;
  return found / tokens.length;
}

/** Phrase match, or token coverage >= minRatio. */
function isTextGrounded(index, text, minRatio) {
  if (containsPhrase(index, text)) return true;
  const coverage = tokenCoverage(index, text);
  return coverage !== null && coverage >= minRatio;
}

function buildReverseAliasMap(aliasMap) {
  const reverse = new Map();
  for (const [alias, canonical] of Object.entries(aliasMap || {})) {
    const key = String(canonical).toLowerCase();
    if (!reverse.has(key)) reverse.set(key, []);
    reverse.get(key).push(alias);
  }
  return reverse;
}

/**
 * A skill is grounded if it (or any alias of its canonical form) appears in the evidence.
 * Compound skills ("React/Redux") are grounded only if every part is grounded.
 */
function isSkillGrounded(skill, index, aliasMap, reverseAliases) {
  if (containsPhrase(index, skill)) return true;

  const canonical = normalizeSkill(skill, aliasMap);
  const parts = (Array.isArray(canonical) ? canonical : [canonical]).filter(Boolean);
  if (parts.length === 0) return false;

  return parts.every((part) => {
    if (containsPhrase(index, part)) return true;
    const aliases = reverseAliases.get(String(part).toLowerCase()) || [];
    return aliases.some((alias) => containsPhrase(index, alias));
  });
}

/**
 * @param {object} draft - ResumeDraft content (plain object)
 * @param {string[]} evidenceTexts - User-supplied texts (resume, self-description)
 * @param {object} [options]
 * @param {Record<string,string>} [options.aliasMap]
 * @returns {{
 *   header: { name: string, contact: string[] },
 *   skills: string[],
 *   educationIds: string[],
 *   excludedItems: Array<{ section: string, text: string, reason: string }>,
 *   warnings: Array<{ section: string, entryId: string, text: string, reason: string }>
 * }}
 */
function groundDraftSections(draft = {}, evidenceTexts = [], { aliasMap = defaultAliases } = {}) {
  const index = buildEvidenceIndex(evidenceTexts);
  const reverseAliases = buildReverseAliasMap(aliasMap);
  const excludedItems = [];
  const warnings = [];

  // 1. Summary: AI-written prose, not decomposed into claims -> never exported as grounded.
  const summary = typeof draft.summary === 'string' ? draft.summary.trim() : '';
  if (summary) {
    excludedItems.push({
      section: 'summary',
      text: summary,
      reason: 'The AI-written summary is not checked claim by claim, so it is left out of the grounded export.',
    });
  }

  // 2. Header: name and contact lines must appear verbatim (normalized) in the evidence.
  const header = { name: '', contact: [] };
  const rawName = typeof draft.name === 'string' ? draft.name.trim() : '';
  if (rawName) {
    if (containsPhrase(index, rawName)) {
      header.name = rawName;
    } else {
      excludedItems.push({ section: 'header', text: rawName, reason: 'Name not found in your resume.' });
    }
  }
  for (const line of Array.isArray(draft.contact) ? draft.contact : []) {
    const value = typeof line === 'string' ? line.trim() : '';
    if (!value) continue;
    if (containsPhrase(index, value)) {
      header.contact.push(value);
    } else {
      excludedItems.push({ section: 'header', text: value, reason: 'Contact detail not found in your resume.' });
    }
  }

  // 3. Skills: each must be present (directly or via a known alias).
  const skills = [];
  for (const raw of Array.isArray(draft.skills) ? draft.skills : []) {
    const skill = typeof raw === 'string' ? raw.trim() : '';
    if (!skill) continue;
    if (isSkillGrounded(skill, index, aliasMap, reverseAliases)) {
      skills.push(skill);
    } else {
      excludedItems.push({
        section: 'skills',
        text: skill,
        reason: 'Skill not found in your resume or self-description.',
      });
    }
  }

  // 4. Education: school (>= half its words) AND degree (all significant words) must appear.
  const educationIds = [];
  for (const edu of Array.isArray(draft.education) ? draft.education : []) {
    if (!edu || !edu.id) continue;
    const label = [edu.degree, edu.school].filter(Boolean).join(', ');
    const schoolOk = isTextGrounded(index, edu.school || '', 0.5);
    const degreeOk = isTextGrounded(index, edu.degree || '', 1);
    if (schoolOk && degreeOk) {
      educationIds.push(edu.id);
    } else {
      excludedItems.push({
        section: 'education',
        text: label,
        reason: !schoolOk
          ? 'School not found in your resume.'
          : 'Degree wording not found in your resume.',
      });
    }
  }

  // 5. Entry headers: warn only (they are rendered when the entry keeps at least one bullet).
  for (const exp of Array.isArray(draft.experience) ? draft.experience : []) {
    if (!exp || !exp.id) continue;
    if (exp.role && !isTextGrounded(index, exp.role, 1)) {
      warnings.push({
        section: 'experience',
        entryId: exp.id,
        text: exp.role,
        reason: 'Job title wording not found in your resume. Check it before sending.',
      });
    }
    if (exp.company && !isTextGrounded(index, exp.company, 0.5)) {
      warnings.push({
        section: 'experience',
        entryId: exp.id,
        text: exp.company,
        reason: 'Company name not found in your resume. Check it before sending.',
      });
    }
  }
  // 6. Projects: the name is only warned about (GitHub projects take their name from the repository, which
  // the user can rename). The technology list is kept item by item: a resume project's technologies must
  // appear in the user's evidence; a GitHub project's come from the repository's own code evidence.
  const projectTech = {};
  for (const prj of Array.isArray(draft.projects) ? draft.projects : []) {
    if (!prj || !prj.id) continue;
    const isGithub = prj.source === 'github';
    if (!isGithub && prj.name && !isTextGrounded(index, prj.name, 0.5)) {
      warnings.push({
        section: 'projects',
        entryId: prj.id,
        text: prj.name,
        reason: 'Project name not found in your resume. Check it before sending.',
      });
    }
    const tech = Array.isArray(prj.tech) ? prj.tech.filter((t) => typeof t === 'string' && t.trim()) : [];
    if (tech.length === 0) continue;
    if (isGithub) {
      projectTech[prj.id] = tech;
      continue;
    }
    const kept = [];
    for (const t of tech) {
      if (isSkillGrounded(t, index, aliasMap, reverseAliases)) {
        kept.push(t);
      } else {
        excludedItems.push({
          section: 'projects',
          text: `${prj.name}: ${t}`,
          reason: 'Technology not found in your resume or self-description.',
        });
      }
    }
    projectTech[prj.id] = kept;
  }

  return { header, skills, educationIds, excludedItems, warnings, projectTech };
}

module.exports = {
  normalizeForMatch,
  buildEvidenceIndex,
  containsPhrase,
  tokenCoverage,
  isSkillGrounded,
  groundDraftSections,
};
