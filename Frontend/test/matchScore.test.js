import { describe, it, expect } from 'vitest';
import { getMatchScoreLabel } from '../src/features/interview/utils/matchScore.js';

describe('Match Score Quality Label Derivation', () => {
  it('returns "Strong match for this role" for scores >= 75', () => {
    expect(getMatchScoreLabel(100)).toBe('Strong match for this role');
    expect(getMatchScoreLabel(85)).toBe('Strong match for this role');
    expect(getMatchScoreLabel(75)).toBe('Strong match for this role');
  });

  it('returns "Moderate match for this role" for scores between 50 and 74', () => {
    expect(getMatchScoreLabel(74)).toBe('Moderate match for this role');
    expect(getMatchScoreLabel(60)).toBe('Moderate match for this role');
    expect(getMatchScoreLabel(50)).toBe('Moderate match for this role');
  });

  it('returns "Weak match for this role" for scores < 50', () => {
    expect(getMatchScoreLabel(49)).toBe('Weak match for this role');
    expect(getMatchScoreLabel(25)).toBe('Weak match for this role');
    expect(getMatchScoreLabel(0)).toBe('Weak match for this role');
  });
});
