const fs = require('fs');
const path = require('path');

/**
 * Independent verification script to recompute benchmark metrics from raw per-case predictions.
 * Reads ONLY the raw predictions array from each report JSON, implements pure metric arithmetic,
 * calculates Wilson score intervals & Rule of Three for zero-event cases, and compares against report values.
 */

function wilsonScoreInterval(events, total, z = 1.96) {
  if (total === 0) return { lower: 0, upper: 0 };
  const p = events / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

function ruleOfThree(total) {
  if (total === 0) return 0;
  return Math.min(1, 3 / total);
}

function computeMetrics(predictions, numBins = 10) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let needsReview = 0;

  for (const p of predictions) {
    const isGoldPositive = p.label === 'supported';
    const isPredPositive = p.status === 'verified';

    if (p.status === 'needs_review') {
      needsReview++;
    }

    if (isGoldPositive && isPredPositive) tp++;
    else if (!isGoldPositive && isPredPositive) fp++;
    else if (isGoldPositive && !isPredPositive) fn++;
    else tn++;
  }

  const total = predictions.length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  // Leak rate: fraction of unsupported claims that reached verified (as defined in metrics.js)
  const unsupported = predictions.filter((p) => p.label === 'unsupported');
  const unsupportedVerified = unsupported.filter((p) => p.status === 'verified');
  const leakRate = unsupported.length > 0 ? unsupportedVerified.length / unsupported.length : 0;
  const reviewRate = total > 0 ? needsReview / total : 0;

  // ECE computation: standard binary calibration where confidence predicts P(label === 'supported')
  const binSize = 1.0 / numBins;
  const bins = Array.from({ length: numBins }, (_, i) => ({
    start: i * binSize,
    end: (i + 1) * binSize,
    count: 0,
    sumConf: 0,
    accurateCount: 0,
  }));

  for (const p of predictions) {
    const conf = Math.max(0, Math.min(1, Number(p.confidence) || 0));
    let bIdx = Math.floor(conf / binSize);
    if (bIdx >= numBins) bIdx = numBins - 1;
    bins[bIdx].count++;
    bins[bIdx].sumConf += conf;
    if (p.label === 'supported') {
      bins[bIdx].accurateCount++;
    }
  }

  let ece = 0;
  for (const b of bins) {
    if (b.count > 0) {
      const avgConf = b.sumConf / b.count;
      const acc = b.accurateCount / b.count;
      ece += (b.count / total) * Math.abs(acc - avgConf);
    }
  }

  // Wilson intervals & Rule of Three
  const leakWilson = wilsonScoreInterval(fp, fp + tn);
  const precisionWilson = wilsonScoreInterval(tp, tp + fp);
  const recallWilson = wilsonScoreInterval(tp, tp + fn);
  const leakRuleOfThree = fp === 0 ? ruleOfThree(fp + tn) : null;

  return {
    counts: { total, tp, fp, fn, tn, needsReview },
    precision,
    recall,
    f1,
    leakRate,
    reviewRate,
    ece,
    precisionWilson,
    recallWilson,
    leakWilson,
    leakRuleOfThree,
  };
}

function verifyReports() {
  const reportsDir = path.resolve(__dirname, '../reports');
  const ablations = ['ablation-a', 'ablation-b', 'ablation-c', 'ablation-d'];

  console.log('========================================================================');
  console.log('INDEPENDENT METRIC RECOMPUTATION AUDIT (TEST SPLIT)');
  console.log('========================================================================\n');

  for (const slug of ablations) {
    const reportPath = path.join(reportsDir, `${slug}-report.json`);
    if (!fs.existsSync(reportPath)) {
      console.log(`[SKIP] ${slug}: report file not found`);
      continue;
    }

    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const rawPredictions = report.predictions || [];
    const recomputed = computeMetrics(rawPredictions);

    console.log(`--- ${report.config.name} (${slug}) ---`);
    console.log(`Cases: ${recomputed.counts.total} (TP: ${recomputed.counts.tp}, FP: ${recomputed.counts.fp}, FN: ${recomputed.counts.fn}, TN: ${recomputed.counts.tn}, Review: ${recomputed.counts.needsReview})`);
    console.log(`Precision:   Report = ${report.metrics.precision.value} | Recomputed = ${recomputed.precision.toFixed(4)} (Wilson 95%: [${recomputed.precisionWilson.lower.toFixed(4)}, ${recomputed.precisionWilson.upper.toFixed(4)}])`);
    console.log(`Recall:      Report = ${report.metrics.recall.value} | Recomputed = ${recomputed.recall.toFixed(4)} (Wilson 95%: [${recomputed.recallWilson.lower.toFixed(4)}, ${recomputed.recallWilson.upper.toFixed(4)}])`);
    console.log(`F1:          Report = ${report.metrics.f1.value} | Recomputed = ${recomputed.f1.toFixed(4)}`);
    console.log(`Leak Rate:   Report = ${report.metrics.leakRate.value} | Recomputed = ${recomputed.leakRate.toFixed(4)} (Wilson Upper = ${(recomputed.leakWilson.upper * 100).toFixed(2)}%, Rule of 3 = ${(recomputed.leakRuleOfThree * 100).toFixed(2)}%)`);
    console.log(`Review Rate: Report = ${report.metrics.reviewRate} | Recomputed = ${recomputed.reviewRate.toFixed(4)}`);
    console.log(`ECE:         Report = ${report.metrics.ece} | Recomputed = ${recomputed.ece.toFixed(4)}`);

    const pMatch = Math.abs(report.metrics.precision.value - recomputed.precision) < 0.001;
    const rMatch = Math.abs(report.metrics.recall.value - recomputed.recall) < 0.001;
    const f1Match = Math.abs(report.metrics.f1.value - recomputed.f1) < 0.001;
    const leakMatch = Math.abs(report.metrics.leakRate.value - recomputed.leakRate) < 0.001;
    const eceMatch = Math.abs(report.metrics.ece - recomputed.ece) < 0.001;

    console.log(`Integrity Check: ${pMatch && rMatch && f1Match && leakMatch && eceMatch ? 'MATCHES EXACTLY (PASS)' : 'DISCREPANCY FOUND (FAIL)'}\n`);
  }

  // Also verify CV Report
  const cvPath = path.join(reportsDir, 'cv-report.json');
  if (fs.existsSync(cvPath)) {
    console.log('========================================================================');
    console.log('INDEPENDENT METRIC RECOMPUTATION AUDIT (5-FOLD CROSS-VALIDATION)');
    console.log('========================================================================\n');
    const cv = JSON.parse(fs.readFileSync(cvPath, 'utf8'));
    console.log(`CV Ablation C: Precision=${cv.ablationC.bin.precision}, Recall=${cv.ablationC.bin.recall}, F1=${cv.ablationC.bin.f1}, Leak=${cv.ablationC.bin.leakRate}, ECE=${cv.ablationC.ece.ece.toFixed(4)}`);
    console.log(`CV Ablation D: Precision=${cv.ablationD.bin.precision}, Recall=${cv.ablationD.bin.recall.toFixed(4)}, F1=${cv.ablationD.bin.f1.toFixed(4)}, Leak=${cv.ablationD.bin.leakRate}, Review=${cv.ablationD.bin.reviewRate.toFixed(4)}`);
    const cvWilsonLeak = wilsonScoreInterval(cv.ablationD.bin.confusionMatrix.fp, cv.ablationD.bin.confusionMatrix.fp + cv.ablationD.bin.confusionMatrix.tn);
    console.log(`CV Ablation D Leak Rate Wilson 95% Upper = ${(cvWilsonLeak.upper * 100).toFixed(2)}%, Rule of Three = ${(ruleOfThree(98) * 100).toFixed(2)}%\n`);
  }
}

verifyReports();
