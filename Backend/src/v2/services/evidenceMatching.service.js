const { rankBySimilarity } = require('../core/similarityScore');

/**
 * Factory for EvidenceMatchingService.
 * Thin service wrapper following dependency injection.
 * Receives the llmClient adapter, embeds chunks ONCE per resume,
 * and delegates scoring to pure functions in core/similarityScore.js.
 */
function createEvidenceMatchingService({
  llmClient,
  cfg = {},
} = {}) {
  if (!llmClient || typeof llmClient.embedTexts !== 'function') {
    throw new Error('createEvidenceMatchingService requires an llmClient with embedTexts');
  }

  const lo = cfg.SIM_LO !== undefined ? Number(cfg.SIM_LO) : 0.5;
  const hi = cfg.SIM_HI !== undefined ? Number(cfg.SIM_HI) : 0.9;

  /**
   * Embeds resume evidence chunks once and returns chunks paired with vectors.
   *
   * @param {Array<object>} chunks - Chunk objects from chunkText()
   * @returns {Promise<{ chunksWithVectors: Array<{ chunk: object, vector: number[] }>, stats: object }>}
   */
  async function prepareEvidenceChunks(chunks = []) {
    if (!Array.isArray(chunks) || chunks.length === 0) {
      return {
        chunksWithVectors: [],
        stats: { hits: 0, misses: 0, apiCalls: 0 },
      };
    }

    const textsToEmbed = chunks.map((c) => c.embedText || c.text);
    const { vectors, stats } = await llmClient.embedTexts(textsToEmbed);

    const chunksWithVectors = chunks.map((chunk, index) => ({
      chunk,
      vector: vectors[index],
    }));

    return {
      chunksWithVectors,
      stats,
    };
  }

  /**
   * Matches a single claim against pre-embedded chunk vectors.
   *
   * @param {string} claimText - The atomic claim string
   * @param {Array<{ chunk: object, vector: number[] }>} chunksWithVectors
   * @param {object} options
   * @param {number} [options.k=3] - Number of top chunks to return
   * @returns {Promise<Array<{ chunk: object, rawCosine: number, similarityScore: number }>>}
   */
  async function matchClaim(claimText, chunksWithVectors = [], { k = 3 } = {}) {
    if (!claimText || typeof claimText !== 'string' || chunksWithVectors.length === 0) {
      return [];
    }

    const { vectors } = await llmClient.embedTexts([claimText]);
    const claimVector = vectors[0];

    return rankBySimilarity(claimVector, chunksWithVectors, {
      k,
      lo,
      hi,
    });
  }

  /**
   * Batched matching of multiple claims against pre-embedded chunks.
   *
   * @param {string[]} claimTexts - Array of atomic claim strings
   * @param {Array<{ chunk: object, vector: number[] }>} chunksWithVectors
   * @param {object} options
   * @param {number} [options.k=3]
   * @returns {Promise<Array<Array<{ chunk: object, rawCosine: number, similarityScore: number }>>>}
   */
  async function matchClaimsBatch(claimTexts = [], chunksWithVectors = [], { k = 3 } = {}) {
    if (!Array.isArray(claimTexts) || claimTexts.length === 0 || chunksWithVectors.length === 0) {
      return [];
    }

    const { vectors: claimVectors } = await llmClient.embedTexts(claimTexts);

    return claimVectors.map((claimVector) =>
      rankBySimilarity(claimVector, chunksWithVectors, {
        k,
        lo,
        hi,
      })
    );
  }

  /**
   * Convenience method: top-k retrieval for a claim given raw chunks.
   * Embeds chunks if not already embedded, then matches claim.
   */
  async function topK(claimText, chunks = [], { k = 3 } = {}) {
    const { chunksWithVectors } = await prepareEvidenceChunks(chunks);
    return matchClaim(claimText, chunksWithVectors, { k });
  }

  return {
    prepareEvidenceChunks,
    matchClaim,
    matchClaimsBatch,
    topK,
  };
}

module.exports = {
  createEvidenceMatchingService,
};
