/**
 * Pure function: computes the L2 norm (Euclidean norm) of a vector
 * and returns the normalized unit vector (length = 1.0).
 * If norm is 0, returns the zero vector without NaN.
 */
function normalizeVector(vector) {
  if (!Array.isArray(vector)) {
    throw new TypeError('Expected an array of numbers');
  }

  let sumSquares = 0;
  for (let i = 0; i < vector.length; i++) {
    sumSquares += vector[i] * vector[i];
  }

  const norm = Math.sqrt(sumSquares);
  if (norm === 0) {
    return vector.slice(); // Return copy of zero vector
  }

  return vector.map((val) => val / norm);
}

module.exports = {
  normalizeVector,
};
