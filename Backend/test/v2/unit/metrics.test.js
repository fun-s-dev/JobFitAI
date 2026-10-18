import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  calculateConfusionMatrix,
  calculateBinaryMetrics,
  calculate3ClassMatrix,
  calculateECE,
  calculateBootstrapCI,
  sweepThresholds,
} = require('../../../src/v2/core/metrics');

describe('core/metrics (pure)', () => {
  /**
   * Hand-computed reference dataset:
   * 10 cases with mixed labels, predicted statuses, and confidence values.
   *
   * Case 1:  label: supported,   status: verified,     conf: 0.92 -> TP
   * Case 2:  label: supported,   status: verified,     conf: 0.88 -> TP
   * Case 3:  label: supported,   status: needs_review, conf: 0.65 -> FN
   * Case 4:  label: supported,   status: rejected,     conf: 0.30 -> FN
   * Case 5:  label: partial,     status: needs_review, conf: 0.60 -> TN (correctly gated)
   * Case 6:  label: partial,     status: verified,     conf: 0.82 -> FP (partial leaked to verified)
   * Case 7:  label: unsupported, status: rejected,     conf: 0.15 -> TN
   * Case 8:  label: unsupported, status: rejected,     conf: 0.25 -> TN
   * Case 9:  label: unsupported, status: needs_review, conf: 0.55 -> TN
   * Case 10: label: unsupported, status: verified,     conf: 0.85 -> FP (fabricated leak)
   *
   * Hand-calculated totals:
   * TP = 2 (cases 1, 2)
   * FP = 2 (cases 6, 10)
   * FN = 2 (cases 3, 4)
   * TN = 4 (cases 5, 7, 8, 9)
   *
   * Precision = TP / (TP + FP) = 2 / 4 = 0.5000
   * Recall    = TP / (TP + FN) = 2 / 4 = 0.5000
   * F1        = 2 * 0.5 * 0.5 / (0.5 + 0.5) = 0.5000
   * FPR       = FP / (FP + TN) = 2 / 6 = 0.3333
   * Leak Rate = (unsupported in verified: 1) / (total unsupported: 4) = 0.2500
   * Review Rate = (items in needs_review: 3) / 10 = 0.3000
   */
  const testSample = [
    { label: 'supported', status: 'verified', confidence: 0.92 },
    { label: 'supported', status: 'verified', confidence: 0.88 },
    { label: 'supported', status: 'needs_review', confidence: 0.65 },
    { label: 'supported', status: 'rejected', confidence: 0.30 },
    { label: 'partial', status: 'needs_review', confidence: 0.60 },
    { label: 'partial', status: 'verified', confidence: 0.82 },
    { label: 'unsupported', status: 'rejected', confidence: 0.15 },
    { label: 'unsupported', status: 'rejected', confidence: 0.25 },
    { label: 'unsupported', status: 'needs_review', confidence: 0.55 },
    { label: 'unsupported', status: 'verified', confidence: 0.85 },
  ];

  it('calculates exact confusion matrix matching hand-worked totals', () => {
    const cm = calculateConfusionMatrix(testSample);
    expect(cm.tp).toBe(2);
    expect(cm.fp).toBe(2);
    expect(cm.fn).toBe(2);
    expect(cm.tn).toBe(4);
    expect(cm.total).toBe(10);
  });

  it('calculates binary metrics: precision, recall, F1, FPR, leak rate, review rate', () => {
    const metrics = calculateBinaryMetrics(testSample);
    expect(metrics.precision).toBeCloseTo(0.5000, 4);
    expect(metrics.recall).toBeCloseTo(0.5000, 4);
    expect(metrics.f1).toBeCloseTo(0.5000, 4);
    expect(metrics.fpr).toBeCloseTo(0.3333, 4);
    expect(metrics.leakRate).toBeCloseTo(0.2500, 4);
    expect(metrics.reviewRate).toBeCloseTo(0.3000, 4);
  });

  it('calculates full 3-class confusion matrix', () => {
    const matrix = calculate3ClassMatrix(testSample);
    // Truth rows: supported, partial, unsupported
    // Pred columns: verified, needs_review, rejected
    expect(matrix.supported.verified).toBe(2);
    expect(matrix.supported.needs_review).toBe(1);
    expect(matrix.supported.rejected).toBe(1);

    expect(matrix.partial.verified).toBe(1);
    expect(matrix.partial.needs_review).toBe(1);
    expect(matrix.partial.rejected).toBe(0);

    expect(matrix.unsupported.verified).toBe(1);
    expect(matrix.unsupported.needs_review).toBe(1);
    expect(matrix.unsupported.rejected).toBe(2);
  });

  it('computes Expected Calibration Error (ECE) across 10 reliability bins', () => {
    const res = calculateECE(testSample, 10);
    expect(res.ece).toBeGreaterThanOrEqual(0);
    expect(res.ece).toBeLessThanOrEqual(1.0);
    expect(Array.isArray(res.bins)).toBe(true);
    expect(res.bins).toHaveLength(10);
  });

  it('computes deterministic seeded bootstrap 95% confidence intervals', () => {
    const ci = calculateBootstrapCI(testSample, (data) => calculateBinaryMetrics(data).precision, {
      resamples: 500,
      seed: 42,
    });
    expect(ci.lower).toBeLessThanOrEqual(ci.upper);
    expect(ci.lower).toBeGreaterThanOrEqual(0.0);
    expect(ci.upper).toBeLessThanOrEqual(1.0);
  });

  it('sweeps thresholds to generate precision-recall operating curve points', () => {
    const sweep = sweepThresholds(testSample, [0.50, 0.70, 0.80, 0.90]);
    expect(sweep).toHaveLength(4);
    // Threshold 0.90 is strictest -> highest precision, lower recall
    const t90 = sweep.find((s) => s.threshold === 0.90);
    expect(t90).toBeDefined();
    expect(t90.precision).toBe(1.0); // Only case 1 (0.92) is >= 0.90 and is supported!
    expect(t90.recall).toBeCloseTo(0.25, 2); // 1 out of 4 supported
  });
});
