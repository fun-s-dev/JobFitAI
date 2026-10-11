const defaultAliases = require('../data/skillAliases.json');

/**
 * Normalizes a single non-compound skill name.
 * - Strips parenthetical qualifiers, e.g. "JavaScript (ES6+)" -> "JavaScript"
 * - Trims, strips trailing punctuation
 * - Resolves canonical alias from aliasMap
 * - Preserves unknown skills in original casing
 *
 * @param {string} rawSkill
 * @param {Record<string, string>} aliasMap
 * @returns {string}
 */
function normalizeSingleSkill(rawSkill, aliasMap) {
  if (typeof rawSkill !== 'string') {
    return '';
  }

  // Trim and collapse multiple consecutive whitespace characters
  let cleaned = rawSkill.trim().replace(/\s+/g, ' ');
  if (!cleaned) {
    return '';
  }

  // Strip parenthetical qualifiers: e.g. "JavaScript (ES6+)" -> "JavaScript"
  const withoutParens = cleaned.replace(/\s*\([^)]*\)/g, '').trim();
  if (withoutParens) {
    cleaned = withoutParens;
  }

  // Strip trailing punctuation often found in lists (e.g. "React,", "Express;")
  // Preserve valid trailing symbols like "C++", "C#", ".NET"
  cleaned = cleaned.replace(/[,;]+$/, '').trim();
  if (!cleaned) {
    return '';
  }

  const lookupKey = cleaned.toLowerCase();
  if (aliasMap && Object.prototype.hasOwnProperty.call(aliasMap, lookupKey)) {
    return aliasMap[lookupKey];
  }

  return cleaned;
}

/**
 * Normalizes a skill name or list of skills using a canonical alias dictionary.
 * - Splits compound skills joined by '&', ',', '/' or ' and ' into separate skills.
 * - Strips parenthetical qualifiers.
 * - Idempotent: f(f(x)) === f(x)
 * - Returns string if input resolves to a single skill; returns string[] if compound/multiple skills.
 *
 * @param {string|string[]} rawSkill
 * @param {Record<string, string>} [aliasMap]
 * @returns {string|string[]} Canonical skill name or array of canonical skill names
 */
function normalizeSkill(rawSkill, aliasMap = defaultAliases) {
  if (rawSkill === null || rawSkill === undefined) {
    return '';
  }

  if (Array.isArray(rawSkill)) {
    const list = [];
    for (const item of rawSkill) {
      const res = normalizeSkill(item, aliasMap);
      if (Array.isArray(res)) {
        list.push(...res);
      } else if (res) {
        list.push(res);
      }
    }
    return Array.from(new Set(list));
  }

  if (typeof rawSkill !== 'string') {
    return '';
  }

  const trimmed = rawSkill.trim().replace(/\s+/g, ' ');
  if (!trimmed) {
    return '';
  }

  // Check if the entire raw skill (e.g. "ci/cd" or "CI/CD") directly matches an alias
  const exactLookupKey = trimmed.toLowerCase();
  if (aliasMap && Object.prototype.hasOwnProperty.call(aliasMap, exactLookupKey)) {
    return aliasMap[exactLookupKey];
  }

  // Check if rawSkill contains compound delimiters ('&', ',', '/', or ' and ')
  const compoundRegex = /\s*(?:&|,|\/|\band\b)\s*/i;
  if (compoundRegex.test(trimmed)) {
    const tokens = trimmed.split(compoundRegex);
    const normalizedList = [];
    for (const token of tokens) {
      const norm = normalizeSingleSkill(token, aliasMap);
      if (norm) {
        normalizedList.push(norm);
      }
    }
    const deduplicated = Array.from(new Set(normalizedList));
    if (deduplicated.length > 1) {
      return deduplicated;
    }
    if (deduplicated.length === 1) {
      return deduplicated[0];
    }
    return '';
  }

  return normalizeSingleSkill(trimmed, aliasMap);
}

module.exports = {
  normalizeSkill,
};
