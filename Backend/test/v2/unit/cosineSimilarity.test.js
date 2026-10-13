import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cosineSimilarity } = require('../../../src/v2/core/cosineSimilarity');

describe('core/cosineSimilarity (pure)', () => {
  it('returns 1 for identical vectors', () => {
    const a = [1, 2, 3];
    const b = [1, 2, 3];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 6);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 6);
  });

  it('returns -1 for opposite vectors', () => {
    const a = [1, 2, 3];
    const b = [-1, -2, -3];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 6);
  });

  it('returns 1 for a scaled copy of a vector', () => {
    const a = [1, 2, 2];
    const b = [2, 4, 4];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 6);
  });

  it('returns 0 (not NaN) when one or both vectors are zero vectors', () => {
    const a = [0, 0, 0];
    const b = [1, 2, 3];
    const zeroZero = cosineSimilarity(a, [0, 0, 0]);
    const zeroB = cosineSimilarity(a, b);
    const bZero = cosineSimilarity(b, [0, 0, 0]);

    expect(Number.isNaN(zeroZero)).toBe(false);
    expect(zeroZero).toBe(0);
    expect(Number.isNaN(zeroB)).toBe(false);
    expect(zeroB).toBe(0);
    expect(Number.isNaN(bZero)).toBe(false);
    expect(bZero).toBe(0);
  });

  it('throws an error on dimension mismatch', () => {
    const a = [1, 2, 3];
    const b = [1, 2];
    expect(() => cosineSimilarity(a, b)).toThrow(/dimension mismatch/i);
  });

  it('calculates the worked example a=[1,2,2], b=[2,1,2] correctly to 8/9', () => {
    const a = [1, 2, 2];
    const b = [2, 1, 2];
    expect(cosineSimilarity(a, b)).toBeCloseTo(8 / 9, 6);
  });
});
