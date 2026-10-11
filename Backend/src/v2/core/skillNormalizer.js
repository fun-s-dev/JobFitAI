const defaultAliases = require('../data/skillAliases.json');

/**
 * Normalizes a skill name using a canonical alias dictionary.
 * - Idempotent: f(f(x)) === f(x)
 * - Tolerant of leading/trailing whitespace, punctuation like trailing commas/semicolons, and casing.
 * - Unknown skills: preserved as trimmed, whitespace-collapsed string in original casing.
 *
 * @param {string} rawSkill
 * @param {Record<string, string>} [aliasMap]
 * @returns {string} Canonical or cleaned skill name
 */
function normalizeSkill(rawSkill, aliasMap = defaultAliases) {
  if (typeof rawSkill !== 'string') {
    return '';
  }

  // Trim and collapse multiple consecutive whitespace characters
  const trimmed = rawSkill.trim().replace(/\s+/g, ' ');
  if (!trimmed) {
    return '';
  }

  // Strip trailing punctuation often found in lists (e.g. "React,", "Express;")
  // Preserve valid trailing symbols like "C++", "C#", ".NET"
  const cleaned = trimmed.replace(/[,;]+$/, '').trim();
  if (!cleaned) {
    return '';
  }

  const lookupKey = cleaned.toLowerCase();
  if (aliasMap && Object.prototype.hasOwnProperty.call(aliasMap, lookupKey)) {
    return aliasMap[lookupKey];
  }

  return cleaned;
}

module.exports = {
  normalizeSkill,
};
