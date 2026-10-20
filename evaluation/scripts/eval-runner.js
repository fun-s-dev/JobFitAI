const fs = require('fs');
const path = require('path');
module.paths.push(path.resolve(__dirname, '../../Backend/node_modules'));
require('dotenv').config({ path: path.resolve(__dirname, '../../Backend/.env') });

const crypto = require('crypto');
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
  calculate3ClassMatrix,
  calculateECE,
  calculateBootstrapCI,
} = require('../../Backend/src/v2/core/metrics');
const EmbeddingCache = require('../../Backend/src/v2/models/embeddingCache.model');
const LlmCall = require('../../Backend/src/v2/models/llmCall.model');
const { QuotaExhaustedError } = require('../../Backend/src/v2/errors/LlmErrors');

function parseArgs() {
  const args = process.argv.slice(2);
  let configPath = null;
  let splitOverride = null;
  let limit = null;
  let cacheDirOverride = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && i + 1 < args.length) {
      configPath = args[++i];
    } else if (args[i].startsWith('--config=')) {
      configPath = args[i].slice('--config='.length);
    } else if (args[i] === '--split' && i + 1 < args.length) {
      splitOverride = args[++i];
    } else if (args[i].startsWith('--split=')) {
      splitOverride = args[i].slice('--split='.length);
    } else if (args[i] === '--limit' && i + 1 < args.length) {
      limit = parseInt(args[++i], 10);
    } else if (args[i].startsWith('--limit=')) {
      limit = parseInt(args[i].slice('--limit='.length), 10);
    } else if (args[i] === '--cache-dir' && i + 1 < args.length) {
      cacheDirOverride = args[++i];
    } else if (args[i].startsWith('--cache-dir=')) {
      cacheDirOverride = args[i].slice('--cache-dir='.length);
    } else if (!configPath && (args[i].endsWith('.json') || args[i].includes('config'))) {
      configPath = args[i];
    }
  }

  if (!configPath) {
    console.error('Error: --config <path> argument is required.');
    process.exit(1);
  }

  return { configPath, splitOverride, limit, cacheDirOverride };
}

function resolveFilePath(inputPath) {
  if (path.isAbsolute(inputPath)) return inputPath;
  const fromCwd = path.resolve(process.cwd(), inputPath);
  if (fs.existsSync(fromCwd)) return fromCwd;
  const fromRoot = path.resolve(__dirname, '../../', inputPath);
  if (fs.existsSync(fromRoot)) return fromRoot;
  return fromCwd;
}

// Record/replay cache decorator around createLlmClient
function createCachedLlmClient(rawLlmClient, cacheDir, statsCollector) {
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  const originalGenerate = rawLlmClient.generateStructured.bind(rawLlmClient);

  async function cachedGenerateStructured(params) {
    const { model, system, prompt, thinkingLevel } = params;
    const modelToUse = model || process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
    const cacheKey = crypto
      .createHash('sha256')
      .update(`${modelToUse}|${system || ''}|${prompt}|${thinkingLevel || ''}`)
      .digest('hex');

    const cacheFile = path.join(cacheDir, `${cacheKey}.json`);

    if (fs.existsSync(cacheFile)) {
      statsCollector.cacheHits++;
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        return cached;
      } catch (err) {
        // Fall back to live call if cache read failed
      }
    }

    statsCollector.cacheMisses++;
    const t0 = Date.now();
    const result = await originalGenerate(params);
    const ms = Date.now() - t0;
    statsCollector.totalLiveCallMs += ms;
    statsCollector.liveApiCalls++;

    fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8');
    return result;
  }

  return {
    ...rawLlmClient,
    generateStructured: cachedGenerateStructured,
  };
}

async function runEvaluation() {
  const { configPath, splitOverride, limit, cacheDirOverride } = parseArgs();
  const resolvedConfigPath = resolveFilePath(configPath);

  if (!fs.existsSync(resolvedConfigPath)) {
    console.error(`Config file not found at: ${resolvedConfigPath}`);
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(resolvedConfigPath, 'utf8'));
  const split = splitOverride || config.split || 'test';
  const slug = config.slug || path.basename(resolvedConfigPath, '.json');

  const appConfig = getCfg();
  console.log(`\n======================================================`);
  console.log(`JobFitAI v2 Evaluation Harness — Milestone 6`);
  console.log(`Pinned Model (GEMINI_MODEL): ${appConfig.GEMINI_MODEL}`);
  console.log(`Configuration: ${config.name} (${slug})`);
  console.log(`Dataset Split: ${split}`);
  console.log(`Signals: ${JSON.stringify(config.signals)}`);
  console.log(`======================================================\n`);

  // Connect to MongoDB Atlas for real callRepo logging and EmbeddingCache
  await mongoose.connect(appConfig.MONGO_URI);

  const statsCollector = {
    cacheHits: 0,
    cacheMisses: 0,
    liveApiCalls: 0,
    totalLiveCallMs: 0,
  };

  const cacheDir = cacheDirOverride
    ? resolveFilePath(cacheDirOverride)
    : (config.cacheDir
      ? (path.isAbsolute(config.cacheDir) ? config.cacheDir : path.resolve(path.dirname(resolvedConfigPath), config.cacheDir))
      : (process.env.EVAL_CACHE_DIR
        ? resolveFilePath(process.env.EVAL_CACHE_DIR)
        : path.resolve(__dirname, '../cache')));
  const reportsDir = path.resolve(__dirname, '../reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const baseLlmClient = createLlmClient({
    apiKey: appConfig.GOOGLE_GENAI_API_KEY,
    generationModel: appConfig.GEMINI_MODEL,
    embeddingModel: appConfig.EMBEDDING_MODEL,
    embeddingDims: appConfig.EMBEDDING_DIMS,
    generateRpm: appConfig.LLM_GENERATE_RPM,
    embedRpm: appConfig.LLM_EMBED_RPM,
    cacheRepo: EmbeddingCache,
    callRepo: LlmCall,
    logger: {
      warn: (obj, msg) => console.log('LOGGER_WARN:', JSON.stringify(obj), msg),
      info: () => {},
      error: (obj, msg) => console.error('LOGGER_ERROR:', JSON.stringify(obj), msg),
    },
  });

  const effectiveCfg = {
    ...appConfig,
    ...(config.SIM_LO !== undefined ? { SIM_LO: config.SIM_LO } : {}),
    ...(config.SIM_HI !== undefined ? { SIM_HI: config.SIM_HI } : {}),
    ...(config.simLo !== undefined ? { SIM_LO: config.simLo } : {}),
    ...(config.simHi !== undefined ? { SIM_HI: config.simHi } : {}),
    ...(config.thresholds?.verified !== undefined ? { THRESHOLD_VERIFIED: config.thresholds.verified } : {}),
    ...(config.thresholds?.review !== undefined ? { THRESHOLD_REVIEW: config.thresholds.review } : {}),
    ...(config.weights?.W_SIM_NOGH !== undefined ? { W_SIM_NOGH: config.weights.W_SIM_NOGH } : {}),
    ...(config.weights?.W_ENT_NOGH !== undefined ? { W_ENT_NOGH: config.weights.W_ENT_NOGH } : {}),
  };

  const cachedLlmClient = createCachedLlmClient(baseLlmClient, cacheDir, statsCollector);

  const evidenceMatchingService = createEvidenceMatchingService({
    llmClient: cachedLlmClient,
    cfg: effectiveCfg,
  });

  const entailmentService = createEntailmentService({
    llmClient: cachedLlmClient,
    cfg: effectiveCfg,
  });

  const verificationService = createVerificationService({
    llmClient: cachedLlmClient,
    evidenceMatchingService,
    entailmentService,
    repos: {
      ResumeClaim: { create: async () => {}, insertMany: async () => {} },
      VerificationRun: { create: async () => {} },
    },
    cfg: effectiveCfg,
  });

  // Load and prepare fixtures
  console.log('Loading and preparing fixture evidence chunks and GitHub fixtures...');
  const fixturesDir = path.resolve(__dirname, '../fixtures');
  const fixtureChunks = {};
  const githubFixtures = {};

  for (const f of fs.readdirSync(fixturesDir)) {
    if (f.endsWith('.json')) {
      const fixtureData = JSON.parse(fs.readFileSync(path.join(fixturesDir, f), 'utf8'));
      if (fixtureData.rawText) {
        const normalized = normalizeText(fixtureData.rawText);
        const rawChunks = chunkText(normalized, { source: 'resume', maxChars: appConfig.MAX_CHUNK_CHARS || 500 });
        const prepared = await evidenceMatchingService.prepareEvidenceChunks(rawChunks);
        fixtureChunks[fixtureData.id] = prepared.chunksWithVectors;
      }
      if (fixtureData.evidenceItems) {
        githubFixtures[fixtureData.id] = fixtureData.evidenceItems;
      }
    }
  }

  // Load dataset
  const dataFile = path.resolve(__dirname, `../data/${split}.jsonl`);
  if (!fs.existsSync(dataFile)) {
    console.error(`Dataset split file not found: ${dataFile}`);
    process.exit(1);
  }

  const allLines = fs.readFileSync(dataFile, 'utf8').trim().split('\n');
  let cases = allLines.map((l) => JSON.parse(l));
  if (limit && limit > 0) {
    cases = cases.slice(0, limit);
  }

  console.log(`Evaluating ${cases.length} cases on '${split}' split...`);

  const predictions = [];
  const partialReportPath = path.join(reportsDir, `partial-${slug}.json`);

  const tStart = Date.now();

  try {
    for (let i = 0; i < cases.length; i++) {
      const item = cases[i];
      process.stdout.write(`[${i + 1}/${cases.length}] Evaluating ${item.id} (${item.caseType})... `);

      let allChunks = fixtureChunks[item.evidence.resume] || [];
      if (item.evidence && (item.evidence.injectedChunk || item.evidence.controlChunk)) {
        const customText = item.evidence.injectedChunk || item.evidence.controlChunk;
        const customChunk = {
          id: `custom_${item.id}`,
          section: 'Experience',
          text: customText,
          context: 'Experience:',
          embedText: `Experience: ${customText}`,
        };
        const prepared = await evidenceMatchingService.prepareEvidenceChunks([customChunk]);
        allChunks = [prepared.chunksWithVectors[0], ...allChunks];
      }

      // Retrieve top matching evidence chunks for this claim to ensure
      // identical judge prompt and cache hit rate across ablations B, C, and D
      const matched = await evidenceMatchingService.matchClaim(item.claim, allChunks, {
        k: appConfig.MAX_EVIDENCE_CHUNKS || 3,
      });

      const chunksWithVectors = matched.map((m) => {
        const found = allChunks.find((c) => c.chunk && c.chunk.id === m.chunk.id);
        return {
          chunk: m.chunk,
          vector: found ? found.vector : null,
          rawCosine: m.rawCosine,
          similarityScore: m.similarityScore,
        };
      });

      const githubItems =
        config.signals?.projectEvidence && item.evidence?.github
          ? githubFixtures[item.evidence.github] || null
          : null;

      const verifiedRecord = await verificationService.verifyOne({
        claim: {
          bulletId: item.id,
          claimText: item.claim,
          claimType: item.caseType === 'metric_fabricated' ? 'metric' : 'technology',
          skills: item.evidence?.skills || item.skills || [],
          numbers: [],
        },
        chunksWithVectors,
        githubItems,
        signals: config.signals,
        weights: config.weights || undefined,
        thresholds: config.thresholds || undefined,
        context: {
          user: null,
          runId: null,
          purpose: `eval_${slug}`,
        },
      });

      const prediction = {
        id: item.id,
        caseType: item.caseType,
        label: item.label,
        status: verifiedRecord.status,
        confidence: verifiedRecord.confidenceScore,
        caps: verifiedRecord.caps || [],
        verdict: verifiedRecord.entailment?.verdict || null,
        quoteUngrounded: verifiedRecord.entailment?.quoteUngrounded || false,
        projectEvidenceScore: verifiedRecord.projectEvidence?.score ?? null,
        contradictions: verifiedRecord.projectEvidence?.contradictions || [],
      };

      predictions.push(prediction);
      console.log(`status: ${prediction.status}, conf: ${prediction.confidence.toFixed(3)}`);

      // Progress checkpoint
      if ((i + 1) % 5 === 0 || i === cases.length - 1) {
        fs.writeFileSync(
          partialReportPath,
          JSON.stringify({ config, completed: i + 1, total: cases.length, predictions }, null, 2),
          'utf8'
        );
      }
    }
  } catch (evalErr) {
    if (evalErr instanceof QuotaExhaustedError) {
      console.error(`\n[FATAL QUOTA ERROR] QuotaExhaustedError hit during evaluation: ${evalErr.message}`);
      console.error('Progress saved to partial report. Resume after quota resets at midnight Pacific.');
      process.exit(2);
    }
    throw evalErr;
  }

  const durationMs = Date.now() - tStart;

  // Calculate metrics
  console.log('\nCalculating evaluation metrics and confidence intervals...');
  const binaryMetrics = calculateBinaryMetrics(predictions);
  const classMatrix = calculate3ClassMatrix(predictions);
  const eceResult = calculateECE(predictions, 10);

  // Bootstrap 95% Confidence Intervals
  const pCI = calculateBootstrapCI(predictions, (d) => calculateBinaryMetrics(d).precision);
  const rCI = calculateBootstrapCI(predictions, (d) => calculateBinaryMetrics(d).recall);
  const f1CI = calculateBootstrapCI(predictions, (d) => calculateBinaryMetrics(d).f1);
  const leakCI = calculateBootstrapCI(predictions, (d) => calculateBinaryMetrics(d).leakRate);

  // Per-caseType breakdown
  const perCaseType = {};
  for (const p of predictions) {
    if (!perCaseType[p.caseType]) {
      perCaseType[p.caseType] = { total: 0, verified: 0, needs_review: 0, rejected: 0 };
    }
    perCaseType[p.caseType].total++;
    perCaseType[p.caseType][p.status]++;
  }

  for (const t of Object.keys(perCaseType)) {
    const s = perCaseType[t];
    s.verifiedRate = Number((s.verified / s.total).toFixed(3));
    s.rejectionRate = Number((s.rejected / s.total).toFixed(3));
  }

  // Injection analysis (Prompt injection & README injection)
  const promptInjCases = predictions.filter((p) => p.caseType === 'prompt_injection');
  const promptInjUpgraded = promptInjCases.filter((p) => p.status === 'verified').length;
  const promptInjAttackRate = promptInjCases.length > 0 ? promptInjUpgraded / promptInjCases.length : 0;

  const readmeInjCases = predictions.filter((p) => p.caseType === 'readme_injection');
  const readmeInjUpgraded = readmeInjCases.filter((p) => p.status === 'verified').length;
  const readmeInjAttackRate = readmeInjCases.length > 0 ? readmeInjUpgraded / readmeInjCases.length : 0;

  const depOnlyCases = predictions.filter((p) => p.caseType === 'dependency_only');
  const depOnlyUpgraded = depOnlyCases.filter((p) => p.status === 'verified').length;
  const depOnlyLeakRate = depOnlyCases.length > 0 ? depOnlyUpgraded / depOnlyCases.length : 0;

  const readmeOnlyCases = predictions.filter((p) => p.caseType === 'readme_only');
  const readmeOnlyUpgraded = readmeOnlyCases.filter((p) => p.status === 'verified').length;
  const readmeOnlyLeakRate = readmeOnlyCases.length > 0 ? readmeOnlyUpgraded / readmeOnlyCases.length : 0;

  const sourceConfirmedCases = predictions.filter((p) => p.caseType === 'source_confirmed');
  const sourceConfirmedVerified = sourceConfirmedCases.filter((p) => p.status === 'verified').length;
  const sourceConfirmedVerifiedRate = sourceConfirmedCases.length > 0 ? sourceConfirmedVerified / sourceConfirmedCases.length : 0;

  const finalReport = {
    evaluationTimestamp: new Date().toISOString(),
    pinnedModel: appConfig.GEMINI_MODEL,
    embeddingModel: appConfig.EMBEDDING_MODEL,
    config: {
      name: config.name,
      slug,
      signals: config.signals,
      weights: config.weights || { W_SIM_NOGH: effectiveCfg.W_SIM_NOGH, W_ENT_NOGH: effectiveCfg.W_ENT_NOGH },
      thresholds: config.thresholds || { verified: effectiveCfg.THRESHOLD_VERIFIED, review: effectiveCfg.THRESHOLD_REVIEW },
      SIM_LO: effectiveCfg.SIM_LO,
      SIM_HI: effectiveCfg.SIM_HI,
    },
    dataset: {
      split,
      caseCount: predictions.length,
    },
    performance: {
      durationMs,
      liveApiCalls: statsCollector.liveApiCalls,
      cacheHits: statsCollector.cacheHits,
      cacheMisses: statsCollector.cacheMisses,
    },
    metrics: {
      precision: {
        value: Number(binaryMetrics.precision.toFixed(4)),
        ci95: [Number(pCI.lower.toFixed(4)), Number(pCI.upper.toFixed(4))],
      },
      recall: {
        value: Number(binaryMetrics.recall.toFixed(4)),
        ci95: [Number(rCI.lower.toFixed(4)), Number(rCI.upper.toFixed(4))],
      },
      f1: {
        value: Number(binaryMetrics.f1.toFixed(4)),
        ci95: [Number(f1CI.lower.toFixed(4)), Number(f1CI.upper.toFixed(4))],
      },
      leakRate: {
        value: Number(binaryMetrics.leakRate.toFixed(4)),
        ci95: [Number(leakCI.lower.toFixed(4)), Number(leakCI.upper.toFixed(4))],
      },
      reviewRate: Number(binaryMetrics.reviewRate.toFixed(4)),
      falsePositiveRate: Number(binaryMetrics.fpr.toFixed(4)),
      ece: Number(eceResult.ece.toFixed(4)),
    },
    confusionMatrix: binaryMetrics.confusionMatrix,
    threeClassMatrix: classMatrix,
    eceReliabilityBins: eceResult.bins,
    perCaseType,
    promptInjection: {
      total: promptInjCases.length,
      upgradedToVerified: promptInjUpgraded,
      attackSuccessRate: Number(promptInjAttackRate.toFixed(4)),
    },
    readmeInjection: {
      total: readmeInjCases.length,
      upgradedToVerified: readmeInjUpgraded,
      attackSuccessRate: Number(readmeInjAttackRate.toFixed(4)),
    },
    githubEvidenceBreakdown: {
      dependencyOnly: { total: depOnlyCases.length, upgradedToVerified: depOnlyUpgraded, leakRate: Number(depOnlyLeakRate.toFixed(4)) },
      readmeOnly: { total: readmeOnlyCases.length, upgradedToVerified: readmeOnlyUpgraded, leakRate: Number(readmeOnlyLeakRate.toFixed(4)) },
      sourceConfirmed: { total: sourceConfirmedCases.length, verified: sourceConfirmedVerified, verifiedRate: Number(sourceConfirmedVerifiedRate.toFixed(4)) },
      readmeInjection: { total: readmeInjCases.length, upgradedToVerified: readmeInjUpgraded, leakRate: Number(readmeInjAttackRate.toFixed(4)) },
    },
    predictions,
  };

  const finalReportPath = path.join(reportsDir, `${slug}-report.json`);
  fs.writeFileSync(finalReportPath, JSON.stringify(finalReport, null, 2), 'utf8');

  // Print Summary Table
  console.log(`\n======================================================`);
  console.log(`Evaluation Completed: ${config.name}`);
  console.log(`======================================================`);
  console.log(`Precision (of VERIFIED): ${(finalReport.metrics.precision.value * 100).toFixed(1)}% [95% CI: ${(finalReport.metrics.precision.ci95[0] * 100).toFixed(1)}% - ${(finalReport.metrics.precision.ci95[1] * 100).toFixed(1)}%]`);
  console.log(`Recall:                  ${(finalReport.metrics.recall.value * 100).toFixed(1)}% [95% CI: ${(finalReport.metrics.recall.ci95[0] * 100).toFixed(1)}% - ${(finalReport.metrics.recall.ci95[1] * 100).toFixed(1)}%]`);
  console.log(`F1 Score:                ${finalReport.metrics.f1.value.toFixed(4)} [95% CI: ${finalReport.metrics.f1.ci95[0].toFixed(4)} - ${finalReport.metrics.f1.ci95[1].toFixed(4)}]`);
  console.log(`Leak Rate:               ${(finalReport.metrics.leakRate.value * 100).toFixed(1)}% [95% CI: ${(finalReport.metrics.leakRate.ci95[0] * 100).toFixed(1)}% - ${(finalReport.metrics.leakRate.ci95[1] * 100).toFixed(1)}%]`);
  console.log(`Review Rate:             ${(finalReport.metrics.reviewRate * 100).toFixed(1)}%`);
  console.log(`ECE:                     ${finalReport.metrics.ece.toFixed(4)}`);
  console.log(`Prompt Injection Leak:   ${(finalReport.promptInjection.attackSuccessRate * 100).toFixed(1)}% (${finalReport.promptInjection.upgradedToVerified}/${finalReport.promptInjection.total})`);
  console.log(`README Injection Leak:   ${(finalReport.readmeInjection.attackSuccessRate * 100).toFixed(1)}% (${finalReport.readmeInjection.upgradedToVerified}/${finalReport.readmeInjection.total})`);
  console.log(`Dependency-Only Leak:    ${(depOnlyLeakRate * 100).toFixed(1)}% (${depOnlyUpgraded}/${depOnlyCases.length})`);
  console.log(`Readme-Only Leak:        ${(readmeOnlyLeakRate * 100).toFixed(1)}% (${readmeOnlyUpgraded}/${readmeOnlyCases.length})`);
  console.log(`Source Confirmed Rec:    ${(sourceConfirmedVerifiedRate * 100).toFixed(1)}% (${sourceConfirmedVerified}/${sourceConfirmedCases.length})`);
  console.log(`Cache: ${statsCollector.cacheHits} hits, ${statsCollector.cacheMisses} misses (${statsCollector.liveApiCalls} live calls, ${durationMs}ms total)`);
  console.log(`Report written to: ${finalReportPath}\n`);

  await mongoose.disconnect();
}

runEvaluation().catch((err) => {
  console.error('Fatal evaluation runner error:', err);
  process.exit(1);
});
