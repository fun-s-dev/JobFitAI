const fs = require('fs');
const path = require('path');
module.paths.push(path.resolve(__dirname, '../../Backend/node_modules'));
require('dotenv').config({ path: path.resolve(__dirname, '../../Backend/.env') });

const mongoose = require('mongoose');

const { getCfg } = require('../../Backend/src/v2/config/env');
const { createLlmClient } = require('../../Backend/src/v2/adapters/llmClient');
const { createEvidenceMatchingService } = require('../../Backend/src/v2/services/evidenceMatching.service');
const { createEntailmentService } = require('../../Backend/src/v2/services/entailment.service');
const { createVerificationService } = require('../../Backend/src/v2/services/verification.service');
const { normalizeText } = require('../../Backend/src/v2/core/normalizeText');
const { chunkText } = require('../../Backend/src/v2/core/chunker');
const {
  calculateBinaryMetrics,
  calculateECE,
  sweepThresholds,
} = require('../../Backend/src/v2/core/metrics');
const EmbeddingCache = require('../../Backend/src/v2/models/embeddingCache.model');
const LlmCall = require('../../Backend/src/v2/models/llmCall.model');

function sigmoid(z) {
  return 1.0 / (1.0 + Math.exp(-Math.max(-15, Math.min(15, z))));
}

// Fit logistic regression: p = sigmoid(w0 + w1 * sim + w2 * ent)
function fitLogisticRegression(trainCases, iterations = 800, lr = 0.1, lambda = 0.001) {
  let w0 = 0.0;
  let w1 = 1.0;
  let w2 = 1.0;

  const valid = trainCases.filter((c) => c.sim !== null && c.ent !== null);
  const n = valid.length;

  for (let iter = 0; iter < iterations; iter++) {
    let grad0 = 0;
    let grad1 = 0;
    let grad2 = 0;

    for (const item of valid) {
      const z = w0 + w1 * item.sim + w2 * item.ent;
      const pred = sigmoid(z);
      const err = pred - item.y;

      grad0 += err;
      grad1 += err * item.sim;
      grad2 += err * item.ent;
    }

    w0 -= (lr * grad0) / n;
    w1 -= (lr * grad1) / n + lr * lambda * w1;
    w2 -= (lr * grad2) / n + lr * lambda * w2;
  }

  const sumWeights = Math.abs(w1) + Math.abs(w2);
  const normW1 = sumWeights > 0 ? Math.abs(w1) / sumWeights : 0.40;
  const normW2 = sumWeights > 0 ? Math.abs(w2) / sumWeights : 0.60;

  return {
    w0: Number(w0.toFixed(4)),
    w1: Number(w1.toFixed(4)),
    w2: Number(w2.toFixed(4)),
    normalizedWeights: {
      W_SIM_NOGH: Number(normW1.toFixed(4)),
      W_ENT_NOGH: Number(normW2.toFixed(4)),
    },
  };
}

async function runCalibration() {
  const appConfig = getCfg();
  console.log(`\n======================================================`);
  console.log(`JobFitAI v2 Offline Calibration (TRAIN Split Only)`);
  console.log(`Pinned Model (GEMINI_MODEL): ${appConfig.GEMINI_MODEL}`);
  console.log(`======================================================\n`);

  await mongoose.connect(appConfig.MONGO_URI);

  const cacheDir = path.resolve(__dirname, '../cache');
  const baseLlmClient = createLlmClient({
    apiKey: appConfig.GOOGLE_GENAI_API_KEY,
    generationModel: appConfig.GEMINI_MODEL,
    embeddingModel: appConfig.EMBEDDING_MODEL,
    embeddingDims: appConfig.EMBEDDING_DIMS,
    generateRpm: appConfig.LLM_GENERATE_RPM,
    embedRpm: appConfig.LLM_EMBED_RPM,
    cacheRepo: EmbeddingCache,
    callRepo: LlmCall,
  });

  const crypto = require('crypto');
  const cachedLlmClient = {
    ...baseLlmClient,
    generateStructured: async (params) => {
      const { model, system, prompt, thinkingLevel } = params;
      const modelToUse = model || process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
      const cacheKey = crypto
        .createHash('sha256')
        .update(`${modelToUse}|${system || ''}|${prompt}|${thinkingLevel || ''}`)
        .digest('hex');
      const cacheFile = path.join(cacheDir, `${cacheKey}.json`);
      if (fs.existsSync(cacheFile)) {
        return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      }
      const res = await baseLlmClient.generateStructured(params);
      fs.writeFileSync(cacheFile, JSON.stringify(res, null, 2), 'utf8');
      return res;
    },
  };

  const evidenceMatchingService = createEvidenceMatchingService({
    llmClient: cachedLlmClient,
    cfg: appConfig,
  });

  const entailmentService = createEntailmentService({
    llmClient: cachedLlmClient,
    cfg: appConfig,
  });

  const verificationService = createVerificationService({
    llmClient: cachedLlmClient,
    evidenceMatchingService,
    entailmentService,
    cfg: appConfig,
  });

  // Load and prepare fixtures
  const fixturesDir = path.resolve(__dirname, '../fixtures');
  const fixtureChunks = {};
  for (const f of fs.readdirSync(fixturesDir)) {
    if (f.endsWith('.json')) {
      const fixtureData = JSON.parse(fs.readFileSync(path.join(fixturesDir, f), 'utf8'));
      const normalized = normalizeText(fixtureData.rawText);
      const rawChunks = chunkText(normalized, { source: 'resume', maxChars: appConfig.MAX_CHUNK_CHARS || 500 });
      const prepared = await evidenceMatchingService.prepareEvidenceChunks(rawChunks);
      fixtureChunks[fixtureData.id] = prepared.chunksWithVectors;
    }
  }

  // Load TRAIN set
  const trainPath = path.resolve(__dirname, '../data/train.jsonl');
  const trainLines = fs.readFileSync(trainPath, 'utf8').trim().split('\n');
  const trainCases = trainLines.map((l) => JSON.parse(l));

  console.log(`Evaluating ${trainCases.length} training cases to gather empirical signals...`);

  const trainSamples = [];
  const supportedRawCosines = [];
  const unsupportedRawCosines = [];

  for (let i = 0; i < trainCases.length; i++) {
    const item = trainCases[i];
    const chunksWithVectors = fixtureChunks[item.evidence.resume] || [];

    const res = await verificationService.verifyOne({
      claim: {
        bulletId: item.id,
        claimText: item.claim,
        claimType: item.caseType === 'metric_fabricated' ? 'metric' : 'technology',
      },
      chunksWithVectors,
      signals: {
        similarity: true,
        entailment: true,
        quoteGrounding: true,
        guardrails: true,
      },
      context: { purpose: 'calibration_train' },
    });

    const topMatch = res.resumeEvidence && res.resumeEvidence.length > 0 ? res.resumeEvidence[0] : null;
    const rawCosine = topMatch ? topMatch.cosine : 0;
    const simScore = topMatch ? topMatch.similarityScore : 0;
    const entScore = res.entailment ? res.entailment.score : 0;

    if (item.label === 'supported') {
      supportedRawCosines.push(rawCosine);
    } else if (item.label === 'unsupported') {
      unsupportedRawCosines.push(rawCosine);
    }

    const y = item.label === 'supported' ? 1.0 : item.label === 'partial' ? 0.5 : 0.0;
    trainSamples.push({
      id: item.id,
      label: item.label,
      y,
      sim: simScore,
      ent: entScore,
      rawCosine,
      confidence: res.confidenceScore,
      status: res.status,
      caps: res.caps,
      verdict: res.entailment?.verdict,
      quoteUngrounded: res.entailment?.quoteUngrounded,
    });
  }

  // 1. Recalibrate SIM_LO and SIM_HI
  supportedRawCosines.sort((a, b) => a - b);
  unsupportedRawCosines.sort((a, b) => a - b);

  const p50Supported = supportedRawCosines[Math.floor(supportedRawCosines.length * 0.5)];
  const p90Supported = supportedRawCosines[Math.floor(supportedRawCosines.length * 0.9)];
  const p50Unsupported = unsupportedRawCosines[Math.floor(unsupportedRawCosines.length * 0.5)];
  const p75Unsupported = unsupportedRawCosines[Math.floor(unsupportedRawCosines.length * 0.75)];

  console.log('\n--- Cosine Distribution Analysis on TRAIN ---');
  console.log(`Supported claims top-1 cosine:   p50=${p50Supported?.toFixed(4)}, p90=${p90Supported?.toFixed(4)}`);
  console.log(`Unsupported claims top-1 cosine: p50=${p50Unsupported?.toFixed(4)}, p75=${p75Unsupported?.toFixed(4)}`);

  // Recommended calibration bounds:
  // SIM_LO: placed near the 75th percentile of unsupported claims (filters background noise)
  // SIM_HI: placed near the 90th percentile of supported claims (avoids premature 1.0 saturation)
  const recommendedSimLo = Number((p75Unsupported || 0.70).toFixed(2));
  const recommendedSimHi = Number((p90Supported || 0.94).toFixed(2));
  console.log(`Calibrated SIM thresholds: SIM_LO = ${recommendedSimLo}, SIM_HI = ${recommendedSimHi} (Default was SIM_LO=0.5, SIM_HI=0.9)`);

  // 2. Fit Logistic Regression on TRAIN
  console.log('\nFitting logistic regression on TRAIN split...');
  const lrResult = fitLogisticRegression(trainSamples);
  console.log(`Learned coefficients: intercept w0 = ${lrResult.w0}, w1 (sim) = ${lrResult.w1}, w2 (ent) = ${lrResult.w2}`);
  console.log(`Learned normalized non-GitHub weights: W_SIM_NOGH = ${lrResult.normalizedWeights.W_SIM_NOGH}, W_ENT_NOGH = ${lrResult.normalizedWeights.W_ENT_NOGH}`);
  console.log(`Default configuration weights:        W_SIM_NOGH = 0.40, W_ENT_NOGH = 0.60`);

  // 3. Threshold Sweep on TRAIN for precision >= 0.95
  console.log('\nRunning threshold sweep on TRAIN split...');
  const trainSweep = sweepThresholds(trainSamples, [0.70, 0.75, 0.80, 0.85, 0.90, 0.95]);
  console.log('Threshold | Precision | Recall | F1 Score | Leak Rate | Review Rate');
  for (const pt of trainSweep) {
    console.log(`   ${pt.threshold.toFixed(2)}   |   ${(pt.precision * 100).toFixed(1)}%   |  ${(pt.recall * 100).toFixed(1)}% |  ${pt.f1.toFixed(4)}  |   ${(pt.leakRate * 100).toFixed(1)}%   |   ${(pt.reviewRate * 100).toFixed(1)}%`);
  }

  // Find lowest threshold achieving precision >= 0.95
  const optimalTrainPoint = trainSweep.find((pt) => pt.precision >= 0.95) || trainSweep[trainSweep.length - 1];
  console.log(`\nSelected VERIFIED Threshold on TRAIN: ${optimalTrainPoint.threshold.toFixed(2)} (Precision: ${(optimalTrainPoint.precision * 100).toFixed(1)}%, Recall: ${(optimalTrainPoint.recall * 100).toFixed(1)}%, Leak Rate: ${(optimalTrainPoint.leakRate * 100).toFixed(1)}%)`);

  // 4. Validate on Held-Out TEST Split
  console.log('\nValidating learned calibration parameters on held-out TEST split...');
  const testPath = path.resolve(__dirname, '../data/test.jsonl');
  const testLines = fs.readFileSync(testPath, 'utf8').trim().split('\n');
  const testCases = testLines.map((l) => JSON.parse(l));

  const testEvaluationsDefault = [];
  const testEvaluationsLearned = [];

  for (const item of testCases) {
    const chunksWithVectors = fixtureChunks[item.evidence.resume] || [];

    // Run with default config
    const resDef = await verificationService.verifyOne({
      claim: {
        bulletId: item.id,
        claimText: item.claim,
        claimType: item.caseType === 'metric_fabricated' ? 'metric' : 'technology',
      },
      chunksWithVectors,
      signals: { similarity: true, entailment: true, quoteGrounding: true, guardrails: true },
      context: { purpose: 'eval_test_default' },
    });
    testEvaluationsDefault.push({
      label: item.label,
      status: resDef.status,
      confidence: resDef.confidenceScore,
      caps: resDef.caps,
      verdict: resDef.entailment?.verdict,
    });

    // Run with learned weights and calibrated threshold
    const resLearned = await verificationService.verifyOne({
      claim: {
        bulletId: item.id,
        claimText: item.claim,
        claimType: item.caseType === 'metric_fabricated' ? 'metric' : 'technology',
      },
      chunksWithVectors,
      signals: { similarity: true, entailment: true, quoteGrounding: true, guardrails: true },
      weights: {
        W_SIM: 0.30,
        W_ENT: 0.40,
        W_PROJ: 0.30,
        W_SIM_NOGH: lrResult.normalizedWeights.W_SIM_NOGH,
        W_ENT_NOGH: lrResult.normalizedWeights.W_ENT_NOGH,
      },
      thresholds: {
        verified: optimalTrainPoint.threshold,
        review: 0.50,
      },
      context: { purpose: 'eval_test_learned' },
    });
    testEvaluationsLearned.push({
      label: item.label,
      status: resLearned.status,
      confidence: resLearned.confidenceScore,
      caps: resLearned.caps,
      verdict: resLearned.entailment?.verdict,
    });
  }

  const defMetrics = calculateBinaryMetrics(testEvaluationsDefault);
  const learnedMetrics = calculateBinaryMetrics(testEvaluationsLearned);
  const defECE = calculateECE(testEvaluationsDefault);
  const learnedECE = calculateECE(testEvaluationsLearned);

  console.log('\n--- HELD-OUT TEST SPLIT COMPARISON ---');
  console.log(`Default (W=0.40/0.60, T=0.80): Precision=${(defMetrics.precision * 100).toFixed(1)}%, Recall=${(defMetrics.recall * 100).toFixed(1)}%, F1=${defMetrics.f1.toFixed(4)}, Leak=${(defMetrics.leakRate * 100).toFixed(1)}%, ECE=${defECE.ece.toFixed(4)}`);
  console.log(`Learned (W=${lrResult.normalizedWeights.W_SIM_NOGH}/${lrResult.normalizedWeights.W_ENT_NOGH}, T=${optimalTrainPoint.threshold.toFixed(2)}): Precision=${(learnedMetrics.precision * 100).toFixed(1)}%, Recall=${(learnedMetrics.recall * 100).toFixed(1)}%, F1=${learnedMetrics.f1.toFixed(4)}, Leak=${(learnedMetrics.leakRate * 100).toFixed(1)}%, ECE=${learnedECE.ece.toFixed(4)}`);

  const calibrationReport = {
    calibratedAt: new Date().toISOString(),
    pinnedModel: appConfig.GEMINI_MODEL,
    trainSplitSize: trainSamples.length,
    testSplitSize: testCases.length,
    empiricalCosineDistribution: {
      supported: { p50: p50Supported, p90: p90Supported },
      unsupported: { p50: p50Unsupported, p75: p75Unsupported },
      recommendedSimLo,
      recommendedSimHi,
    },
    logisticRegression: lrResult,
    trainThresholdSweep: trainSweep,
    selectedVerifiedThreshold: optimalTrainPoint.threshold,
    testComparison: {
      default: { ...defMetrics, ece: defECE.ece },
      calibrated: { ...learnedMetrics, ece: learnedECE.ece },
    },
  };

  const reportsDir = path.resolve(__dirname, '../reports');
  const reportPath = path.join(reportsDir, 'calibration-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(calibrationReport, null, 2), 'utf8');
  console.log(`\nCalibration report written to ${reportPath}`);

  await mongoose.disconnect();
}

runCalibration().catch((err) => {
  console.error('Calibration error:', err);
  process.exit(1);
});
