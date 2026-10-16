import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { toEntailmentScore } = require('../../../src/v2/core/entailmentScore');

describe('core/entailmentScore (pure)', () => {
  it('maps yes, partial, and no verdicts to numeric scores using defaults', () => {
    expect(toEntailmentScore('yes')).toBe(1.0);
    expect(toEntailmentScore('partial')).toBe(0.5);
    expect(toEntailmentScore('no')).toBe(0.0);
  });

  it('respects custom configuration weights if passed', () => {
    const customConfig = {
      ENTAILMENT_SCORE_YES: 0.9,
      ENTAILMENT_SCORE_PARTIAL: 0.4,
      ENTAILMENT_SCORE_NO: 0.1,
    };

    expect(toEntailmentScore('yes', customConfig)).toBe(0.9);
    expect(toEntailmentScore('partial', customConfig)).toBe(0.4);
    expect(toEntailmentScore('no', customConfig)).toBe(0.1);
  });

  it('returns 0.0 for unknown or missing verdicts', () => {
    expect(toEntailmentScore('unknown')).toBe(0.0);
    expect(toEntailmentScore(null)).toBe(0.0);
    expect(toEntailmentScore(undefined)).toBe(0.0);
  });
});
