import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeVector } = require('../../../src/v2/core/normalize');

describe('v2 Core: normalizeVector (L2 normalization)', () => {
  it('normalizes a 3D vector to unit length', () => {
    const v = [3, 4, 0];
    const normalized = normalizeVector(v);

    expect(normalized[0]).toBeCloseTo(0.6, 5);
    expect(normalized[1]).toBeCloseTo(0.8, 5);
    expect(normalized[2]).toBe(0);

    const length = Math.sqrt(
      normalized[0] * normalized[0] +
      normalized[1] * normalized[1] +
      normalized[2] * normalized[2]
    );
    expect(length).toBeCloseTo(1.0, 5);
  });

  it('handles already normalized unit vector without modification', () => {
    const v = [1, 0, 0];
    const normalized = normalizeVector(v);
    expect(normalized).toEqual([1, 0, 0]);
  });

  it('safely handles zero vector without throwing or producing NaN', () => {
    const v = [0, 0, 0];
    const normalized = normalizeVector(v);
    expect(normalized).toEqual([0, 0, 0]);
    expect(Number.isNaN(normalized[0])).toBe(false);
  });

  it('throws on non-array input', () => {
    expect(() => normalizeVector(null)).toThrow(TypeError);
    expect(() => normalizeVector('not-an-array')).toThrow(TypeError);
  });
});
