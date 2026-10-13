const { cosineSimilarity } = require('./cosineSimilarity');

/**
 * Pure function: rescales raw cosine similarity to [0, 1] using linear interpolation
 * clamped between lo and hi.
 *
 * similarityScore = clamp((cos - lo) / (hi - lo), 0, 1)
 */
function scaleSimilarity(cos, lo = 0.5, hi = 0.9) {
  if (hi <= lo) {
    throw new Error('hi threshold must be strictly greater than lo threshold');
  }

  if (cos <= lo) return 0;
  if (cos >= hi) return 1;

  return (cos - lo) / (hi - lo);
}

/**
 * Pure function: ranks candidate chunks against a claim vector using cosine similarity.
 *
 * @param {Array<number>|Float32Array} claimVector - Embedding vector for the claim
 * @param {Array<{ chunk: object, vector: Array<number>|Float32Array }>} chunkItems - Chunks paired with vectors
 * @param {object} options
 * @param {number} [options.k=3] - Max chunks to return
 * @param {number} [options.lo=0.5] - Min cosine threshold for scaling
 * @param {number} [options.hi=0.9] - Max cosine threshold for scaling
 * @returns {Array<{ chunk: object, rawCosine: number, similarityScore: number }>}
 */
function rankBySimilarity(claimVector, chunkItems = [], { k = 3, lo = 0.5, hi = 0.9 } = {}) {
  if (!Array.isArray(chunkItems) || chunkItems.length === 0) {
    return [];
  }

  const scored = chunkItems.map((item) => {
    const rawCosine = cosineSimilarity(claimVector, item.vector);
    const similarityScore = scaleSimilarity(rawCosine, lo, hi);
    return {
      chunk: item.chunk,
      rawCosine,
      similarityScore,
    };
  });

  scored.sort((a, b) => b.rawCosine - a.rawCosine);

  return scored.slice(0, k);
}

module.exports = {
  scaleSimilarity,
  rankBySimilarity,
};
