/**
 * Pure evaluation metrics functions for JobFitAI v2 benchmark harness.
 * Implements binary and 3-class confusion matrices, precision/recall/F1,
 * leak rate, review rate, Expected Calibration Error (ECE), seeded bootstrap CIs,
 * and precision-recall threshold sweeps.
 *
 * No DB, no network, zero external dependencies.
 */

function calculateConfusionMatrix(predictions = []) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;

  for (const item of predictions) {
    const isPredVerified = item.status === 'verified';
    const isGroundSupported = item.label === 'supported';

    if (isPredVerified && isGroundSupported) {
      tp++;
    } else if (isPredVerified && !isGroundSupported) {
      fp++;
    } else if (!isPredVerified && isGroundSupported) {
      fn++;
    } else {
      tn++;
    }
  }

  return {
    tp,
    fp,
    fn,
    tn,
    total: predictions.length,
  };
}

function calculateBinaryMetrics(predictions = []) {
  const cm = calculateConfusionMatrix(predictions);
  const total = cm.total;

  const precision = cm.tp + cm.fp > 0 ? cm.tp / (cm.tp + cm.fp) : 0;
  const recall = cm.tp + cm.fn > 0 ? cm.tp / (cm.tp + cm.fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const fpr = cm.fp + cm.tn > 0 ? cm.fp / (cm.fp + cm.tn) : 0;

  // Leak rate: fraction of unsupported (fabricated) claims that reached VERIFIED
  const unsupportedItems = predictions.filter((p) => p.label === 'unsupported');
  const unsupportedLeaked = unsupportedItems.filter((p) => p.status === 'verified');
  const leakRate = unsupportedItems.length > 0 ? unsupportedLeaked.length / unsupportedItems.length : 0;

  // Review rate: fraction of claims landing in NEEDS_REVIEW
  const reviewCount = predictions.filter((p) => p.status === 'needs_review').length;
  const reviewRate = total > 0 ? reviewCount / total : 0;

  return {
    confusionMatrix: cm,
    precision,
    recall,
    f1,
    fpr,
    leakRate,
    reviewRate,
    sampleSize: total,
  };
}

function calculate3ClassMatrix(predictions = []) {
  const matrix = {
    supported: { verified: 0, needs_review: 0, rejected: 0 },
    partial: { verified: 0, needs_review: 0, rejected: 0 },
    unsupported: { verified: 0, needs_review: 0, rejected: 0 },
  };

  for (const item of predictions) {
    const label = matrix[item.label] ? item.label : 'unsupported';
    const status = ['verified', 'needs_review', 'rejected'].includes(item.status)
      ? item.status
      : 'rejected';
    matrix[label][status]++;
  }

  return matrix;
}

function calculateECE(predictions = [], numBins = 10) {
  if (predictions.length === 0) {
    return { ece: 0, bins: [] };
  }

  const binStep = 1.0 / numBins;
  const bins = [];

  for (let i = 0; i < numBins; i++) {
    const binStart = i * binStep;
    const binEnd = (i + 1) * binStep;
    bins.push({
      binIndex: i,
      binStart,
      binEnd,
      items: [],
    });
  }

  for (const item of predictions) {
    const conf = Math.max(0, Math.min(1, Number(item.confidence) || 0));
    let binIdx = Math.floor(conf / binStep);
    if (binIdx >= numBins) binIdx = numBins - 1;
    bins[binIdx].items.push(item);
  }

  let totalEce = 0;
  const n = predictions.length;
  const binSummaries = bins.map((b) => {
    const count = b.items.length;
    if (count === 0) {
      return {
        binStart: b.binStart,
        binEnd: b.binEnd,
        count: 0,
        avgConfidence: 0,
        accuracy: 0,
      };
    }

    const avgConfidence = b.items.reduce((acc, curr) => acc + curr.confidence, 0) / count;
    const accurateCount = b.items.filter((item) => item.label === 'supported').length;
    const accuracy = accurateCount / count;
    const absDiff = Math.abs(accuracy - avgConfidence);

    totalEce += (count / n) * absDiff;

    return {
      binStart: b.binStart,
      binEnd: b.binEnd,
      count,
      avgConfidence,
      accuracy,
    };
  });

  return {
    ece: totalEce,
    bins: binSummaries,
  };
}

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function calculateBootstrapCI(items = [], metricFn, { resamples = 1000, seed = 20261018, ci = 0.95 } = {}) {
  if (items.length === 0) {
    return { mean: 0, lower: 0, upper: 0 };
  }

  const rng = mulberry32(seed);
  const n = items.length;
  const values = [];

  for (let b = 0; b < resamples; b++) {
    const sample = [];
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rng() * n);
      sample.push(items[idx]);
    }
    values.push(metricFn(sample));
  }

  values.sort((a, b) => a - b);

  const alpha = 1.0 - ci;
  const lowerIndex = Math.max(0, Math.floor((alpha / 2) * resamples));
  const upperIndex = Math.min(resamples - 1, Math.ceil((1.0 - alpha / 2) * resamples));

  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;

  return {
    mean,
    lower: values[lowerIndex],
    upper: values[upperIndex],
  };
}

function sweepThresholds(predictions = [], candidateThresholds = [0.50, 0.60, 0.70, 0.80, 0.90], reviewThreshold = 0.50) {
  return candidateThresholds.map((threshold) => {
    // Reclassify predictions based on threshold
    const mapped = predictions.map((p) => {
      const conf = p.confidence ?? 0;
      let status;
      if (conf >= threshold) {
        status = 'verified';
      } else if (conf >= reviewThreshold) {
        status = 'needs_review';
      } else {
        status = 'rejected';
      }

      // Preserve any hard caps or verdict 'no' if present on the prediction object
      if (p.caps && p.caps.includes('needs_review') && status === 'verified') {
        status = 'needs_review';
      }
      if (p.caps && p.caps.includes('rejected')) {
        status = 'rejected';
      }
      if (p.verdict === 'no' || p.quoteUngrounded) {
        status = 'rejected';
      }

      return {
        ...p,
        status,
      };
    });

    const m = calculateBinaryMetrics(mapped);
    return {
      threshold,
      precision: m.precision,
      recall: m.recall,
      f1: m.f1,
      leakRate: m.leakRate,
      reviewRate: m.reviewRate,
      tp: m.confusionMatrix.tp,
      fp: m.confusionMatrix.fp,
      fn: m.confusionMatrix.fn,
      tn: m.confusionMatrix.tn,
    };
  });
}

module.exports = {
  calculateConfusionMatrix,
  calculateBinaryMetrics,
  calculate3ClassMatrix,
  calculateECE,
  calculateBootstrapCI,
  sweepThresholds,
};
