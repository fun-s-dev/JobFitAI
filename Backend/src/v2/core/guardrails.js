const {
  extractNumericTokens,
  normalizeNumericToken,
} = require('./coverageCheck');

// Explicit leadership verbs to detect in claims
const CLAIM_LEADERSHIP_REGEX =
  /\b(?:led|lead|leading|leadership|managed|managing|headed|heading|directed|directing|mentored|mentoring|owned|owning|founded|founding|architected|architecting|spearheaded|spearheading|oversaw|overseeing)\b/i;

// Active leadership cues in evidence text
// Excludes passive nouns like "team lead" or subordinate support phrases ("assisted", "worked with")
const EVIDENCE_LEADERSHIP_REGEX =
  /\b(?:led|managed|headed|directed|mentored|founded|architected|spearheaded|oversaw)\b|(?<!\b(?:team|the|our|a|project)\s+)\b(?:lead|leading)\b/i;

/**
 * Pure function to evaluate deterministic safety guardrails.
 *
 * Enforces:
 * 1. Number Rule: Every numeric token claimed in `claim.numbers` (or claimText)
 *    must appear in the evidence chunks after normalization.
 *    Missing number -> caps with 'needs_review'.
 * 2. Leadership Rule: If claim asserts a leadership/ownership verb, evidence
 *    must contain an explicit active leadership cue.
 *    Absence of cue -> caps with 'needs_review'.
 *
 * @param {object} params
 * @param {object} params.claim
 * @param {string} params.claim.claimText
 * @param {string[]} [params.claim.numbers]
 * @param {Array<{ text: string }>} params.chunks
 * @returns {{ caps: string[] }}
 */
function evaluateGuardrails({ claim = {}, chunks = [] }) {
  const caps = new Set();
  const claimText = typeof claim.claimText === 'string' ? claim.claimText : '';

  // Concatenate all evidence chunk texts
  const evidenceText = chunks
    .map((c) => (c && typeof c.text === 'string' ? c.text : ''))
    .join(' ');

  // -------------------------------------------------------------
  // 1. Number Rule
  // -------------------------------------------------------------
  // Extract numbers from claim if not already populated
  const rawClaimNumbers =
    Array.isArray(claim.numbers) && claim.numbers.length > 0
      ? claim.numbers
      : extractNumericTokens(claimText);

  if (rawClaimNumbers.length > 0) {
    const evidenceNumbers = new Set(
      extractNumericTokens(evidenceText).map(normalizeNumericToken)
    );

    const hasMissingNumber = rawClaimNumbers.some((rawNum) => {
      const normalizedClaimNum = normalizeNumericToken(rawNum);
      return !evidenceNumbers.has(normalizedClaimNum);
    });

    if (hasMissingNumber) {
      caps.add('needs_review');
    }
  }

  // -------------------------------------------------------------
  // 2. Leadership Rule
  // -------------------------------------------------------------
  const claimHasLeadership = CLAIM_LEADERSHIP_REGEX.test(claimText);

  if (claimHasLeadership) {
    const evidenceHasLeadership = EVIDENCE_LEADERSHIP_REGEX.test(evidenceText);
    if (!evidenceHasLeadership) {
      caps.add('needs_review');
    }
  }

  return {
    caps: Array.from(caps),
  };
}

module.exports = {
  evaluateGuardrails,
  CLAIM_LEADERSHIP_REGEX,
  EVIDENCE_LEADERSHIP_REGEX,
};
