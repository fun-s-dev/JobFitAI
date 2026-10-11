const skillAliases = require('../data/skillAliases.json');
const { normalizeSkill } = require('./skillNormalizer');

// Ambiguous short names that must only be matched with exact casing to avoid English false positives
const AMBIGUOUS_SHORT_NAMES = new Set(['Go', 'R', 'C', 'Spring', 'Express', 'Net', 'Next', 'Git']);

/**
 * Normalizes a numeric token for robust equality comparison.
 * e.g. "40 %" === "40%", "1,000" === "1000", "$2M" === "2m"
 */
function normalizeNumericToken(token) {
  if (typeof token !== 'string') return '';
  return token
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')       // remove whitespace (e.g. "40 %" -> "40%")
    .replace(/^[$€£]/, '')      // strip leading currency symbols ($2M -> 2m)
    .replace(/,/g, '');         // remove thousand commas (1,000 -> 1000)
}

/**
 * Extracts numeric tokens from text including percentages, multipliers,
 * metric prefixes (k/M/B), decimals, and p-percentiles.
 */
function extractNumericTokens(text) {
  if (typeof text !== 'string') return [];

  const tokens = [];
  // Matches:
  // 1. Percentile metrics: p95, p99, p50
  // 2. Numbers with optional currency, commas/decimals, and optional suffixes (%, k, M, B, x)
  const regex = /(?:\bp\d+\b|\$?\b\d+(?:[.,]\d+)*(?:\s*%|[kKmMbB]|x|X)?(?!\w))/g;

  let match;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[0].trim();
    // Filter out lone punctuation or invalid matches
    if (/\d/.test(raw)) {
      tokens.push(raw);
    }
  }

  return tokens;
}

/**
 * Extracts technology tokens from text, strictly skipping sentence-starting verbs
 * and detecting only known skills, CamelCase, dotted names, and ALL-CAPS acronyms.
 */
function extractTechTokens(text) {
  if (typeof text !== 'string') return [];

  const tokens = new Set();
  const trimmed = text.trim();

  // 1. Skip the first word of the bullet (e.g., "Architected", "Built", "Developed")
  const firstWordMatch = trimmed.match(/^([A-Za-z]+)\b/);
  const firstWord = firstWordMatch ? firstWordMatch[1] : '';
  const bodyText = firstWord ? trimmed.slice(firstWord.length).trim() : trimmed;

  // 2. Dotted names (e.g. Node.js, Vue.js, ASP.NET, .NET)
  const dottedRegex = /\b[A-Za-z0-9]+\.(?:js|net|io|ai|org)\b|\b\.[nN][eE][tT]\b/gi;
  let match;
  while ((match = dottedRegex.exec(bodyText)) !== null) {
    tokens.add(match[0].trim());
  }

  // 3. CamelCase (must contain at least one lowercase followed by an uppercase, e.g. GraphQL, JavaScript)
  const camelCaseRegex = /\b[A-Z][a-z]+[A-Z][A-Za-z0-9]*\b/g;
  while ((match = camelCaseRegex.exec(bodyText)) !== null) {
    tokens.add(match[0].trim());
  }

  // 4. ALL-CAPS acronyms of 2+ letters (e.g. AWS, REST, SQL, API, CI/CD, JWT)
  const acronymRegex = /\b[A-Z]{2,}(?:\/[A-Z]+)?\b/g;
  while ((match = acronymRegex.exec(bodyText)) !== null) {
    const acronym = match[0].trim();
    // Ignore common non-tech uppercase words like OK, AM, PM
    if (!['OK', 'AM', 'PM', 'US', 'UK'].includes(acronym)) {
      tokens.add(acronym);
    }
  }

  // 5. Known skills from alias dictionary
  // Check canonical skills and aliases with appropriate casing rules
  const canonicalSkills = new Set(Object.values(skillAliases));
  for (const skill of canonicalSkills) {
    if (AMBIGUOUS_SHORT_NAMES.has(skill)) {
      // Must match exact capitalization on word boundaries
      const exactRegex = new RegExp(`\\b${escapeRegExp(skill)}\\b`);
      if (exactRegex.test(bodyText)) {
        tokens.add(skill);
      }
    } else {
      // Case-insensitive boundary match for unambiguous technical names
      const looseRegex = new RegExp(`\\b${escapeRegExp(skill)}\\b`, 'i');
      if (looseRegex.test(bodyText)) {
        tokens.add(skill);
      }
    }
  }

  return Array.from(tokens);
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Deterministic coverage check:
 * - Every numeric token in the bullet must appear in some claim's numbers (or text).
 * - Every technology token in the bullet must appear in some claim's skills or text.
 *
 * @param {string} bulletText
 * @param {Array<{ claimText: string, skills?: string[], numbers?: string[] }>} claims
 * @returns {{ ok: boolean, missingNumbers: string[], missingTech: string[] }}
 */
function checkBulletCoverage(bulletText, claims = []) {
  const bulletNumbers = extractNumericTokens(bulletText);
  const bulletTech = extractTechTokens(bulletText);

  // Normalize all numbers provided across claims
  const claimNumbersNormalized = new Set();
  const allClaimsText = [];

  for (const claim of claims) {
    if (Array.isArray(claim.numbers)) {
      for (const num of claim.numbers) {
        claimNumbersNormalized.add(normalizeNumericToken(num));
      }
    }
    if (claim.claimText) {
      allClaimsText.push(claim.claimText);
    }
  }

  const combinedClaimsText = allClaimsText.join(' ');
  const combinedClaimsNumbers = extractNumericTokens(combinedClaimsText).map(normalizeNumericToken);
  for (const n of combinedClaimsNumbers) {
    claimNumbersNormalized.add(n);
  }

  // Check missing numbers
  const missingNumbers = [];
  for (const rawNum of bulletNumbers) {
    const norm = normalizeNumericToken(rawNum);
    if (!claimNumbersNormalized.has(norm)) {
      missingNumbers.push(rawNum);
    }
  }

  // Normalize all skills provided across claims
  const claimSkillsNormalized = new Set();
  for (const claim of claims) {
    if (Array.isArray(claim.skills)) {
      for (const s of claim.skills) {
        claimSkillsNormalized.add(normalizeSkill(s).toLowerCase());
      }
    }
  }

  // Check missing technologies
  const missingTech = [];
  for (const tech of bulletTech) {
    const canonicalTech = normalizeSkill(tech).toLowerCase();
    const inClaimSkills = claimSkillsNormalized.has(canonicalTech);
    const inClaimText = new RegExp(`\\b${escapeRegExp(tech)}\\b`, 'i').test(combinedClaimsText);

    if (!inClaimSkills && !inClaimText) {
      missingTech.push(tech);
    }
  }

  return {
    ok: missingNumbers.length === 0 && missingTech.length === 0,
    missingNumbers,
    missingTech,
  };
}

module.exports = {
  checkBulletCoverage,
  extractNumericTokens,
  extractTechTokens,
  normalizeNumericToken,
};
