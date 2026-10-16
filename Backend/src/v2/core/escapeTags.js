/**
 * Pure function to neutralize wrapper tags in untrusted text.
 * Prevents delimiter confusion and prompt-injection escaping.
 *
 * Normalizes Unicode via NFKC (collapsing fullwidth brackets and lookalikes)
 * and neutralizes both opening and closing tags of prompt delimiters
 * (evidence, claim, section, instruction), case-insensitively with whitespace tolerance.
 *
 * e.g. "</evidence>" -> "<\/evidence>"
 *      "<evidence id='...'>" -> "<\evidence id='...'>"
 *
 * @param {string} text
 * @returns {string}
 */
function escapeWrapperTags(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return '';
  }

  // Normalize Unicode to canonical equivalence (NFKC) to catch fullwidth brackets like ＜ ＞
  const normalized = text.normalize('NFKC');

  // Match opening or closing tags for known wrapper delimiters
  // Handles whitespace variants like "</ EVIDENCE >", "<  claim >", "< evidence id='1' >"
  const tagRegex = /(<)(\s*\/?\s*(?:evidence|claim|section|instruction)\b[^>]*>)/gi;

  return normalized.replace(tagRegex, '<\\$2');
}

module.exports = {
  escapeWrapperTags,
};
