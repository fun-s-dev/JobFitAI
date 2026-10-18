import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { toStatus } = require('../../../src/v2/core/toStatus');

describe('toStatus (pure)', () => {
  const defaultThresholds = {
    verified: 0.80,
    review: 0.50,
  };

  describe('table-driven threshold and boundary test', () => {
    const testCases = [
      // [name, confidence, caps, thresholds, verdict, expectedStatus]
      ['boundary 1.0 -> verified', 1.0, [], defaultThresholds, null, 'verified'],
      ['clear verified (0.85) -> verified', 0.85, [], defaultThresholds, null, 'verified'],
      ['exact boundary 0.80 -> verified', 0.80, [], defaultThresholds, null, 'verified'],
      ['just below verified (0.799) -> needs_review', 0.799, [], defaultThresholds, null, 'needs_review'],
      ['middle review band (0.65) -> needs_review', 0.65, [], defaultThresholds, null, 'needs_review'],
      ['exact boundary 0.50 -> needs_review', 0.50, [], defaultThresholds, null, 'needs_review'],
      ['just below review band (0.499) -> rejected', 0.499, [], defaultThresholds, null, 'rejected'],
      ['low score (0.30) -> rejected', 0.30, [], defaultThresholds, null, 'rejected'],
      ['zero score (0.0) -> rejected', 0.0, [], defaultThresholds, null, 'rejected'],

      // Caps enforcement
      ['high score (0.90) with needs_review cap -> needs_review', 0.90, ['needs_review'], defaultThresholds, null, 'needs_review'],
      ['exact 0.80 with needs_review cap -> needs_review', 0.80, ['needs_review'], defaultThresholds, null, 'needs_review'],
      ['review score (0.65) with needs_review cap remains needs_review', 0.65, ['needs_review'], defaultThresholds, null, 'needs_review'],
      ['rejected score (0.40) with needs_review cap remains rejected', 0.40, ['needs_review'], defaultThresholds, null, 'rejected'],
      ['high score (0.95) with rejected cap -> rejected', 0.95, ['rejected'], defaultThresholds, null, 'rejected'],
      ['review score (0.65) with rejected cap -> rejected', 0.65, ['rejected'], defaultThresholds, null, 'rejected'],

      // Verdict 'no' enforcement
      ['high score (0.90) with verdict "no" forces rejected', 0.90, [], defaultThresholds, 'no', 'rejected'],
      ['exact 0.80 with verdict "no" forces rejected', 0.80, [], defaultThresholds, 'no', 'rejected'],
      ['review score (0.65) with verdict "no" forces rejected', 0.65, [], defaultThresholds, 'no', 'rejected'],
      ['verdict "partial" does not force rejected', 0.85, [], defaultThresholds, 'partial', 'verified'],
      ['verdict "yes" does not force rejected', 0.85, [], defaultThresholds, 'yes', 'verified'],

      // Custom thresholds
      ['custom thresholds: 0.82 with verified=0.85 -> needs_review', 0.82, [], { verified: 0.85, review: 0.60 }, null, 'needs_review'],
      ['custom thresholds: 0.58 with review=0.60 -> rejected', 0.58, [], { verified: 0.85, review: 0.60 }, null, 'rejected'],
      ['custom thresholds: 0.86 with verified=0.85 -> verified', 0.86, [], { verified: 0.85, review: 0.60 }, null, 'verified'],
    ];

    testCases.forEach(([name, confidence, caps, thresholds, verdict, expected]) => {
      it(name, () => {
        const actual = toStatus(confidence, caps, thresholds, verdict);
        expect(actual).toBe(expected);
      });
    });
  });

  it('pulls thresholds from global config if thresholds parameter is omitted', () => {
    expect(toStatus(0.85)).toBe('verified');
    expect(toStatus(0.65)).toBe('needs_review');
    expect(toStatus(0.40)).toBe('rejected');
  });
});
