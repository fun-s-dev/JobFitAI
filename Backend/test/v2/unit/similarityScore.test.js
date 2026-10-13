import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  scaleSimilarity,
  rankBySimilarity,
} = require('../../../src/v2/core/similarityScore');

describe('core/similarityScore (pure)', () => {
  describe('scaleSimilarity', () => {
    it('clamps values below lo to 0', () => {
      expect(scaleSimilarity(0.4, 0.5, 0.9)).toBe(0);
      expect(scaleSimilarity(-0.2, 0.5, 0.9)).toBe(0);
    });

    it('clamps values above hi to 1', () => {
      expect(scaleSimilarity(0.95, 0.5, 0.9)).toBe(1);
      expect(scaleSimilarity(1.0, 0.5, 0.9)).toBe(1);
    });

    it('scales linearly between lo and hi', () => {
      // (0.7 - 0.5) / (0.9 - 0.5) = 0.2 / 0.4 = 0.5
      expect(scaleSimilarity(0.7, 0.5, 0.9)).toBeCloseTo(0.5, 6);
      // (0.8 - 0.5) / (0.9 - 0.5) = 0.3 / 0.4 = 0.75
      expect(scaleSimilarity(0.8, 0.5, 0.9)).toBeCloseTo(0.75, 6);
    });

    it('throws if hi <= lo', () => {
      expect(() => scaleSimilarity(0.7, 0.9, 0.5)).toThrow(/must be strictly greater/i);
      expect(() => scaleSimilarity(0.7, 0.5, 0.5)).toThrow(/must be strictly greater/i);
    });
  });

  describe('rankBySimilarity', () => {
    it('ranks chunks in descending order of cosine similarity and caps at k', () => {
      const claimVector = [1, 0, 0];
      const chunksWithVectors = [
        { chunk: { id: 'c1', text: 'low match' }, vector: [0.2, 0.8, 0] },
        { chunk: { id: 'c2', text: 'exact match' }, vector: [1, 0, 0] },
        { chunk: { id: 'c3', text: 'mid match' }, vector: [0.7, 0.3, 0] },
        { chunk: { id: 'c4', text: 'zero match' }, vector: [0, 1, 0] },
      ];

      const ranked = rankBySimilarity(claimVector, chunksWithVectors, {
        k: 3,
        lo: 0.5,
        hi: 0.9,
      });

      expect(ranked).toHaveLength(3);
      expect(ranked[0].chunk.id).toBe('c2');
      expect(ranked[0].rawCosine).toBeCloseTo(1.0, 5);
      expect(ranked[0].similarityScore).toBe(1.0);

      expect(ranked[1].chunk.id).toBe('c3');
      expect(ranked[1].rawCosine).toBeGreaterThan(ranked[2].rawCosine);

      expect(ranked[2].chunk.id).toBe('c1');
    });

    it('handles empty chunk list gracefully', () => {
      const claimVector = [1, 0, 0];
      const ranked = rankBySimilarity(claimVector, [], { k: 3 });
      expect(ranked).toEqual([]);
    });
  });
});
