/**
 * Pure function: calculates the cosine similarity between two vectors a and b.
 * cos(a, b) = (a · b) / (|a| × |b|)
 *
 * Requirements:
 * - Identical vectors -> 1
 * - Orthogonal vectors -> 0
 * - Opposite vectors -> -1
 * - Scaled copy -> 1
 * - Zero vector -> 0 (never NaN)
 * - Dimension mismatch throws Error
 */
function cosineSimilarity(a, b) {
  if (!a || !b || !Array.isArray(a) && !ArrayBuffer.isView(a) || a.length !== b.length) {
    throw new Error('Dimension mismatch: vectors must have the exact same length');
  }

  let dot = 0;
  let na = 0;
  let nb = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }

  if (na === 0 || nb === 0) {
    return 0; // Return 0, never NaN
  }

  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

module.exports = {
  cosineSimilarity,
};
