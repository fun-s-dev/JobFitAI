const { z } = require('zod');

/**
 * Zod schema for structured LLM entailment verification.
 *
 * NOTE on field order:
 * Autoregressive language models generate tokens sequentially from left to right.
 * Placing `evidenceQuote` and `missingElements` BEFORE `verdict` acts as a lightweight,
 * structured chain-of-thought constraint. The model commits to the extracted evidence
 * tokens first, keeping them in its causal context window before producing the verdict.
 */
const EntailmentSchema = z.object({
  evidenceQuote: z
    .string()
    .describe('Verbatim quote from the evidence text of <= 25 words that supports the claim. Return empty string if no evidence supports it.'),
  missingElements: z
    .array(z.string())
    .describe('List of specific facts, metrics, or technologies asserted in the claim that are NOT supported by the evidence.'),
  verdict: z
    .enum(['yes', 'partial', 'no'])
    .describe('Strict entailment verdict: "yes" if claim is fully entailed, "partial" if partially entailed, "no" if unsupported or contradicted.'),
});

module.exports = {
  EntailmentSchema,
};
