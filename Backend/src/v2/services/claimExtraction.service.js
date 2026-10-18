const { BatchClaimsSchema } = require('../schemas/claim');
const { checkBulletCoverage } = require('../core/coverageCheck');
const { normalizeSkill } = require('../core/skillNormalizer');

function createClaimExtractionService({ llmClient, batchSize = 3 } = {}) {
  if (!llmClient || typeof llmClient.generateStructured !== 'function') {
    throw new Error('A valid llmClient adapter is required for createClaimExtractionService');
  }

  const systemInstruction = [
    'You are a strict atomic claim extraction engine for resume verification.',
    'Deconstruct each input resume bullet into atomic, independently checkable facts.',
    'System Rules:',
    '1. ONE FACT PER CLAIM: Each claim must assert exactly one minimal proposition (action, technology, metric, outcome, leadership, or responsibility).',
    '2. SELF-CONTAINED: Resolve all pronouns so each claim stands alone without requiring surrounding context.',
    '3. NO INVENTED INFORMATION: Never add claims, facts, or assumptions not explicitly stated in the bullet text.',
    '4. COPY NUMBERS VERBATIM: Copy every numeric token, percentage, multiplier, and metric exactly as written into the "numbers" array.',
    '5. LIST SKILLS: List all technical tools, languages, frameworks, or skills mentioned into the "skills" array.',
    '6. PRESERVE BULLET ID: Assign each claim the exact bulletId provided in the input labels.',
    '7. CLASSIFY TYPE: Must be one of: technology, responsibility, metric, leadership, outcome, or other.',
  ].join('\n');

  /**
   * Extracts atomic claims from a batch of bullets.
   *
   * @param {Array<{ id: string, text: string }>} bullets
   * @param {object} [options]
   * @returns {Promise<{ claims: Array<object>, incompleteBullets: string[] }>}
   */
  async function extractClaimsFromBullets(bullets = [], { user = null, runId = null, requestId = null } = {}) {
    if (!Array.isArray(bullets) || bullets.length === 0) {
      return { claims: [], incompleteBullets: [] };
    }

    const allClaims = [];
    const incompleteBullets = new Set();

    // Process bullets in batches
    for (let i = 0; i < bullets.length; i += batchSize) {
      const batch = bullets.slice(i, i + batchSize);
      const validBulletIds = new Set(batch.map((b) => b.id));

      const batchPromptLines = [
        'Extract atomic claims for the following resume bullets:',
        '',
      ];
      for (const bullet of batch) {
        batchPromptLines.push(`[${bullet.id}]: ${bullet.text}`);
      }
      batchPromptLines.push('', 'Return the extracted claims matching the requested schema.');

      // Call LLM with Gemini default temperature (temperature omitted) and low thinking level
      const result = await llmClient.generateStructured({
        purpose: 'extract_atomic_claims',
        system: systemInstruction,
        prompt: batchPromptLines.join('\n'),
        schema: BatchClaimsSchema,
        thinkingLevel: 'LOW',
        user,
        runId,
        requestId,
      });

      // Reject any returned claim whose bulletId was not in the batch (hallucinated ID defense)
      const rawClaims = Array.isArray(result?.claims) ? result.claims : [];
      const batchClaimsByBulletId = new Map();
      for (const b of batch) {
        batchClaimsByBulletId.set(b.id, []);
      }

      for (const claim of rawClaims) {
        if (validBulletIds.has(claim.bulletId)) {
          batchClaimsByBulletId.get(claim.bulletId).push(claim);
        }
      }

      // Check coverage and zero-claims for each bullet in the batch
      for (const bullet of batch) {
        let currentClaims = batchClaimsByBulletId.get(bullet.id) || [];
        let coverage = checkBulletCoverage(bullet.text, currentClaims);

        // If zero claims or coverage check failed, trigger a single retry for this bullet
        if (currentClaims.length === 0 || !coverage.ok) {
          const retryPromptLines = [
            `Extract atomic claims for bullet [${bullet.id}]: ${bullet.text}`,
            '',
            'Your previous extraction was incomplete.',
          ];
          if (coverage.missingNumbers.length > 0) {
            retryPromptLines.push(`Missing numbers to include: ${coverage.missingNumbers.join(', ')}`);
          }
          if (coverage.missingTech.length > 0) {
            retryPromptLines.push(`Missing technologies to include: ${coverage.missingTech.join(', ')}`);
          }
          retryPromptLines.push(
            'Ensure every number and technology in the bullet appears in the claims.',
            'Return corrected claims matching the schema.'
          );

          const retryResult = await llmClient.generateStructured({
            purpose: 'retry_extract_claims',
            system: systemInstruction,
            prompt: retryPromptLines.join('\n'),
            schema: BatchClaimsSchema,
            thinkingLevel: 'LOW',
            user,
            runId,
            requestId,
          });

          const retryClaims = (retryResult?.claims || []).filter(
            (c) => c.bulletId === bullet.id
          );

          if (retryClaims.length > 0) {
            const retryCoverage = checkBulletCoverage(bullet.text, retryClaims);
            currentClaims = retryClaims;
            coverage = retryCoverage;
          }


          // If still failing coverage or has 0 claims after retry, flag as extraction_incomplete
          if (currentClaims.length === 0 || !coverage.ok) {
            incompleteBullets.add(bullet.id);
          }
        }

        // Normalize skills on all accepted claims
        for (const claim of currentClaims) {
          const normalizedSkills = Array.from(
            new Set(
              (Array.isArray(claim.skills) ? claim.skills : [])
                .flatMap((s) => {
                  const res = normalizeSkill(s);
                  return Array.isArray(res) ? res : [res];
                })
                .filter(Boolean)
            )
          );

          allClaims.push({
            ...claim,
            skills: normalizedSkills,
          });
        }
      }
    }

    return {
      claims: allClaims,
      incompleteBullets: Array.from(incompleteBullets),
    };
  }

  return {
    extractClaimsFromBullets,
  };
}

module.exports = {
  createClaimExtractionService,
};
