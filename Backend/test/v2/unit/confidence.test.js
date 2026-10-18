import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { calculateConfidence } = require('../../../src/v2/core/confidence');

describe('calculateConfidence (pure)', () => {
  const defaultWeights = {
    W_SIM: 0.30,
    W_ENT: 0.40,
    W_PROJ: 0.30,
    W_SIM_NOGH: 0.40,
    W_ENT_NOGH: 0.60,
  };

  it('reproduces the guide worked example with project evidence: 0.71', () => {
    // 0.30 * 0.80 + 0.40 * 0.50 + 0.30 * 0.90 = 0.24 + 0.20 + 0.27 = 0.71
    const score = calculateConfidence(
      {
        similarityScore: 0.80,
        entailmentScore: 0.50,
        projectEvidenceScore: 0.90,
      },
      defaultWeights
    );

    expect(score).toBe(0.71);
  });

  it('reproduces the guide worked example without project evidence (null): 0.62', () => {
    // 0.40 * 0.80 + 0.60 * 0.50 = 0.32 + 0.30 = 0.62
    const score = calculateConfidence(
      {
        similarityScore: 0.80,
        entailmentScore: 0.50,
        projectEvidenceScore: null,
      },
      defaultWeights
    );

    expect(score).toBe(0.62);
  });

  it('treats undefined projectEvidenceScore as null and uses W_SIM_NOGH/W_ENT_NOGH: 0.62', () => {
    const score = calculateConfidence(
      {
        similarityScore: 0.80,
        entailmentScore: 0.50,
      },
      defaultWeights
    );

    expect(score).toBe(0.62);
  });

  it('re-normalizes weights when similarityScore is null but entailment and project exist', () => {
    // With similarity missing, applicable weights are W_ENT: 0.40 and W_PROJ: 0.30 (sum = 0.70)
    // Normalized W_ENT = 0.40 / 0.70 ≈ 0.571428...
    // Normalized W_PROJ = 0.30 / 0.70 ≈ 0.428571...
    // Expected = (0.40 * 1.0 + 0.30 * 0.70) / 0.70 = (0.40 + 0.21) / 0.70 = 0.61 / 0.70 ≈ 0.8714
    const score = calculateConfidence(
      {
        similarityScore: null,
        entailmentScore: 1.0,
        projectEvidenceScore: 0.70,
      },
      defaultWeights
    );

    expect(score).toBeCloseTo(0.61 / 0.70, 4);
  });

  it('re-normalizes weights when only entailmentScore applies (similarity and project null)', () => {
    // Only entailment applies -> weight becomes 1.0 -> confidence = 0.75
    const score = calculateConfidence(
      {
        similarityScore: null,
        entailmentScore: 0.75,
        projectEvidenceScore: null,
      },
      defaultWeights
    );

    expect(score).toBe(0.75);
  });

  it('returns 0 when all applicable signals are 0 or null', () => {
    const score = calculateConfidence(
      {
        similarityScore: 0,
        entailmentScore: 0,
        projectEvidenceScore: null,
      },
      defaultWeights
    );

    expect(score).toBe(0);

    const scoreAllNull = calculateConfidence(
      {
        similarityScore: null,
        entailmentScore: null,
        projectEvidenceScore: null,
      },
      defaultWeights
    );

    expect(scoreAllNull).toBe(0);
  });

  it('clamps output strictly within [0, 1]', () => {
    const scoreMax = calculateConfidence(
      {
        similarityScore: 1.0,
        entailmentScore: 1.0,
        projectEvidenceScore: 1.0,
      },
      defaultWeights
    );

    expect(scoreMax).toBe(1.0);
  });

  it('pulls weights from global config if weights parameter is omitted', () => {
    const score = calculateConfidence({
      similarityScore: 0.80,
      entailmentScore: 0.50,
      projectEvidenceScore: 0.90,
    });

    expect(score).toBe(0.71);
  });
});
