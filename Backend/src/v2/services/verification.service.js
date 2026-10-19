const mongoose = require('mongoose');
const { getCfg } = require('../config/env');
const { createLimiter } = require('../utils/limiter');
const { normalizeText } = require('../core/normalizeText');
const { chunkText } = require('../core/chunker');
const { calculateConfidence } = require('../core/confidence');
const { toStatus } = require('../core/toStatus');
const defaultResumeClaim = require('../models/resumeClaim.model');
const defaultVerificationRun = require('../models/verificationRun.model');
const defaultResumeDraft = require('../models/resumeDraft.model');
const defaultInterviewReport = require('../../models/interviewReport.model');

class VerificationError extends Error {
  constructor(message, status = 500, code = 'VERIFICATION_ERROR', retryAfter = null) {
    super(message);
    this.name = 'VerificationError';
    this.status = status;
    this.code = code;
    if (retryAfter !== null) {
      this.retryAfter = retryAfter;
    }
  }
}

/**
 * Factory for creating the Verification Service.
 * Orchestrates draft retrieval, claim extraction, evidence chunking & embedding,
 * bounded concurrency verification, and all-or-nothing atomic persistence.
 */
function createVerificationService({
  llmClient,
  _draftService,
  claimExtractionService,
  evidenceMatchingService,
  entailmentService,
  repos = {},
  logger = console,
  cfg: runtimeCfg,
} = {}) {
  let cfg = runtimeCfg;
  if (!cfg) {
    try {
      cfg = getCfg();
    } catch {
      cfg = {};
    }
  }

  const ResumeClaim = repos.ResumeClaim || defaultResumeClaim;
  const VerificationRun = repos.VerificationRun || defaultVerificationRun;
  const ResumeDraft = repos.ResumeDraft || defaultResumeDraft;
  const InterviewReport = repos.InterviewReport || defaultInterviewReport;

  const concurrency = cfg.LLM_CONCURRENCY || 5;
  const limiter = createLimiter(concurrency);

  const defaultWeights = {
    W_SIM: cfg.W_SIM ?? 0.30,
    W_ENT: cfg.W_ENT ?? 0.40,
    W_PROJ: cfg.W_PROJ ?? 0.30,
    W_SIM_NOGH: cfg.W_SIM_NOGH ?? 0.40,
    W_ENT_NOGH: cfg.W_ENT_NOGH ?? 0.60,
  };

  const defaultThresholds = {
    verified: cfg.THRESHOLD_VERIFIED ?? 0.80,
    review: cfg.THRESHOLD_REVIEW ?? 0.50,
  };

  const generationModel = cfg.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const embeddingModel = cfg.EMBEDDING_MODEL || 'gemini-embedding-001';
  const embeddingDims = cfg.EMBEDDING_DIMS || 768;
  const simLo = cfg.SIM_LO ?? 0.5;
  const simHi = cfg.SIM_HI ?? 0.9;

  /**
   * Verifies a single claim against evidence chunks purely in memory.
   * Does NOT touch the database. Used in production verification and by M6 eval harness.
   *
   * @param {object} params
   * @param {object} params.claim - Atomic claim object { bulletId, claimText, claimType, skills, numbers }
   * @param {Array<{ chunk: object, vector: number[] }>} [params.chunksWithVectors=[]]
   * @param {Array<object>} [params.chunks=[]] - Fallback raw chunks if vectors not precomputed
   * @param {Array|null} [params.githubItems=null] - Project evidence items (null in M5)
   * @param {object} [params.signals] - Ablation flags { similarity, entailment, quoteGrounding, guardrails }
   * @param {object} [params.context] - { user, runId, reportId }
   * @returns {Promise<object>} Single verified claim record with provenance
   */
  async function verifyOne({
    claim,
    claimVector = null,
    chunksWithVectors = [],
    chunks = [],
    githubItems = null,
    signals = {
      similarity: true,
      entailment: true,
      quoteGrounding: true,
      guardrails: true,
    },
    weights = defaultWeights,
    thresholds = defaultThresholds,
    context = {},
  } = {}) {
    if (!claim || !claim.claimText) {
      throw new Error('A valid claim object with claimText is required for verifyOne');
    }

    const useSimilarity = signals?.similarity !== false;
    const useEntailment = signals?.entailment !== false;
    const useQuoteGrounding = signals?.quoteGrounding !== false;
    const useGuardrails = signals?.guardrails !== false;

    // Ensure chunksWithVectors are available if similarity is needed
    let preparedChunks = chunksWithVectors;
    if (preparedChunks.length === 0 && chunks.length > 0 && evidenceMatchingService) {
      const prepared = await evidenceMatchingService.prepareEvidenceChunks(chunks);
      preparedChunks = prepared.chunksWithVectors;
    }

    // 1. Evidence Retrieval & Similarity
    let topSimilarity = null;
    let resumeEvidence = [];
    let evidenceChunksForJudge = [];

    if (useSimilarity && evidenceMatchingService && preparedChunks.length > 0) {
      const matches = await evidenceMatchingService.matchClaim(claim.claimText, preparedChunks, {
        k: cfg.MAX_EVIDENCE_CHUNKS || 3,
        claimVector,
      });

      if (matches.length > 0) {
        topSimilarity = matches[0].similarityScore;
        resumeEvidence = matches.map((m) => ({
          chunkId: m.chunk.id || '',
          source: m.chunk.source || 'resume',
          section: m.chunk.section || '',
          text: m.chunk.text || '',
          start: m.chunk.start || 0,
          end: m.chunk.end || 0,
          cosine: m.rawCosine || 0,
          similarityScore: m.similarityScore || 0,
        }));
        evidenceChunksForJudge = matches.map((m) => m.chunk);
      }
    } else {
      // If similarity signal disabled or no matches, take top chunks directly
      evidenceChunksForJudge = preparedChunks.slice(0, 3).map((item) => item.chunk || item);
    }

    // 2. Entailment Judgment
    let entailmentRes = {
      verdict: 'no',
      rawVerdict: 'no',
      evidenceQuote: '',
      missingElements: [],
      quoteUngrounded: false,
      caps: [],
      entailmentScore: 0.0,
    };

    if (useEntailment && entailmentService) {
      entailmentRes = await entailmentService.evaluateClaim(
        { claim, evidenceChunks: evidenceChunksForJudge },
        {
          user: context.user || null,
          runId: context.runId || null,
          quoteGrounding: useQuoteGrounding,
          guardrails: useGuardrails,
        }
      );
    }

    const entailmentScore = useEntailment ? entailmentRes.entailmentScore : null;
    const verdict = useEntailment ? entailmentRes.verdict : null;
    const caps = useGuardrails ? entailmentRes.caps || [] : [];

    // 3. Project Evidence (null in M5)
    let projectEvidenceScore = null;
    if (githubItems && Array.isArray(githubItems) && githubItems.length > 0) {
      // Reserved for M8 project evidence integration
      projectEvidenceScore = null;
    }

    // 4. Confidence Score (pure)
    const confidenceScore = calculateConfidence(
      {
        similarityScore: topSimilarity,
        entailmentScore,
        projectEvidenceScore,
      },
      weights
    );

    // 5. Automated Status (pure)
    const status = toStatus(confidenceScore, caps, thresholds, verdict);

    return {
      bulletId: claim.bulletId,
      claimText: claim.claimText,
      claimType: claim.claimType || 'other',
      skills: Array.isArray(claim.skills) ? claim.skills : [],
      numbers: Array.isArray(claim.numbers) ? claim.numbers : [],
      resumeEvidence,
      entailment: {
        verdict: entailmentRes.verdict || 'no',
        score: entailmentRes.entailmentScore ?? 0,
        evidenceQuote: entailmentRes.evidenceQuote || '',
        missingElements: entailmentRes.missingElements || [],
        quoteUngrounded: entailmentRes.quoteUngrounded || false,
      },
      projectEvidence: {
        score: projectEvidenceScore,
        evidenceItemIds: [],
        contradictions: [],
      },
      caps,
      confidenceScore,
      status, // Automated verdict (write-once)
      userOverride: null,
      provenance: {
        generationModel,
        embeddingModel,
        weights,
        thresholds,
        verifiedAt: new Date(),
      },
    };
  }

  /**
   * Executes the full end-to-end verification pipeline for an interview report.
   * Computes EVERYTHING in memory first; persists via all-or-nothing rollback/transaction.
   *
   * @param {object} params
   * @param {string} params.reportId
   * @param {string} params.userId
   * @param {string} [params.draftId=null]
   * @param {string[]} [params.githubAnalysisIds=[]]
   * @returns {Promise<{ run: object, claims: Array<object> }>}
   */
  async function verifyReport({
    reportId,
    userId,
    draftId = null,
    githubAnalysisIds = [],
    onProgress = null,
  } = {}) {
    if (!reportId || !userId) {
      throw new VerificationError('reportId and userId are required', 400, 'INVALID_INPUT');
    }

    // 1. Load owned report
    const report = await InterviewReport.findOne({ _id: reportId, user: userId });
    if (!report) {
      throw new VerificationError('Report not found', 404, 'NOT_FOUND');
    }

    // 2. Load latest or specified ResumeDraft
    let draft = null;
    if (draftId) {
      draft = await ResumeDraft.findOne({ _id: draftId, report: reportId, user: userId });
    } else {
      draft = await ResumeDraft.findOne({ report: reportId, user: userId }).sort({ createdAt: -1 });
    }

    if (!draft || !draft.draft) {
      throw new VerificationError(
        'A structured resume draft is required before verification',
        409,
        'draft_required'
      );
    }

    // 3. Extract atomic claims from draft bullets
    const bullets = [];
    if (Array.isArray(draft.draft.experience)) {
      for (const exp of draft.draft.experience) {
        if (Array.isArray(exp.bullets)) {
          for (const b of exp.bullets) {
            if (b && b.id && b.text) {
              bullets.push({ id: b.id, text: b.text });
            }
          }
        }
      }
    }

    if (Array.isArray(draft.draft.projects)) {
      for (const prj of draft.draft.projects) {
        if (Array.isArray(prj.bullets)) {
          for (const b of prj.bullets) {
            if (b && b.id && b.text) {
              bullets.push({ id: b.id, text: b.text });
            }
          }
        }
      }
    }

    let extractedClaims = [];
    try {
      if (claimExtractionService && bullets.length > 0) {
        const extraction = await claimExtractionService.extractClaimsFromBullets(bullets, {
          user: userId,
        });
        extractedClaims = extraction.claims || [];
      }
    } catch (err) {
      if (err && (err.name === 'QuotaExhaustedError' || err.code === 'LLM_QUOTA_EXHAUSTED')) {
        throw err;
      }
      if (logger && typeof logger.error === 'function') {
        logger.error({ err: err.message }, 'Claim extraction failed during verification');
      }
      throw new VerificationError(
        'Upstream service temporarily unavailable during claim extraction',
        503,
        'UPSTREAM_UNAVAILABLE',
        30
      );
    }

    // 4. Chunk resume text + self-description
    const resumeText = report.resume || report.resumeText || '';
    const selfDescText = report.selfDescription || '';
    const normalizedResume = normalizeText(resumeText);
    const resumeChunks = chunkText(normalizedResume, { source: 'resume' });

    let selfDescChunks = [];
    if (selfDescText && selfDescText.trim()) {
      const normalizedSelfDesc = normalizeText(selfDescText);
      selfDescChunks = chunkText(normalizedSelfDesc, { source: 'self_description' });
    }

    const allChunks = [...resumeChunks, ...selfDescChunks];

    // 5. Pre-embed evidence chunks
    let chunksWithVectors = [];
    if (evidenceMatchingService && allChunks.length > 0) {
      try {
        const prepared = await evidenceMatchingService.prepareEvidenceChunks(allChunks);
        chunksWithVectors = prepared.chunksWithVectors;
      } catch (err) {
        if (err && (err.name === 'QuotaExhaustedError' || err.code === 'LLM_QUOTA_EXHAUSTED')) {
          throw err;
        }
        if (logger && typeof logger.error === 'function') {
          logger.error({ err: err.message }, 'Evidence embedding failed during verification');
        }
        throw new VerificationError(
          'Upstream service temporarily unavailable during embedding',
          503,
          'UPSTREAM_UNAVAILABLE',
          30
        );
      }
    }

    // 5.5 Pre-embed all extracted claims in ONE batched embedTexts call
    let claimVectors = [];
    if (llmClient && typeof llmClient.embedTexts === 'function' && extractedClaims.length > 0) {
      try {
        const claimTexts = extractedClaims.map((c) => c.claimText);
        const embedded = await llmClient.embedTexts(claimTexts, {
          user: userId,
          purpose: 'embed_claims_batch',
        });
        claimVectors = embedded.vectors || [];
      } catch (err) {
        if (err && (err.name === 'QuotaExhaustedError' || err.code === 'LLM_QUOTA_EXHAUSTED')) {
          throw err;
        }
        if (logger && typeof logger.error === 'function') {
          logger.error({ err: err.message }, 'Claim embedding batch failed during verification');
        }
        throw new VerificationError(
          'Upstream service temporarily unavailable during claim embedding',
          503,
          'UPSTREAM_UNAVAILABLE',
          30
        );
      }
    }

    // 6. Verify each claim in memory with bounded concurrency
    let verifiedClaimData = [];
    let doneClaimsCount = 0;
    const totalClaims = extractedClaims.length;

    if (typeof onProgress === 'function') {
      try {
        await onProgress({ done: 0, total: totalClaims });
      } catch {}
    }

    try {
      verifiedClaimData = await Promise.all(
        extractedClaims.map((claim, idx) =>
          limiter(async () => {
            const evaluated = await verifyOne({
              claim,
              claimVector: claimVectors[idx] || null,
              chunksWithVectors,
              githubItems: null,
              signals: {
                similarity: true,
                entailment: true,
                quoteGrounding: true,
                guardrails: true,
              },
              weights: defaultWeights,
              thresholds: defaultThresholds,
              context: { user: userId, reportId },
            });
            doneClaimsCount++;
            if (typeof onProgress === 'function') {
              try {
                await onProgress({ done: doneClaimsCount, total: totalClaims });
              } catch {}
            }
            return evaluated;
          })
        )
      );
    } catch (err) {
      if (err && (err.name === 'QuotaExhaustedError' || err.code === 'LLM_QUOTA_EXHAUSTED')) {
        throw err;
      }
      if (logger && typeof logger.error === 'function') {
        logger.error({ err: err.message }, 'Claim evaluation failed during verification');
      }
      throw new VerificationError(
        'Upstream service temporarily unavailable during claim verification',
        503,
        'UPSTREAM_UNAVAILABLE',
        30
      );
    }

    // 7. Calculate counts
    const counts = { verified: 0, needsReview: 0, rejected: 0 };
    for (const c of verifiedClaimData) {
      if (c.status === 'verified') counts.verified++;
      else if (c.status === 'needs_review') counts.needsReview++;
      else counts.rejected++;
    }

    // 8. Atomic Persistence (All-or-Nothing)
    const runConfig = {
      weights: defaultWeights,
      thresholds: defaultThresholds,
      similarityScale: { lo: simLo, hi: simHi },
      generationModel,
      embeddingModel,
      embeddingDims,
    };

    let session = null;
    let isTransactionActive = false;

    if (
      mongoose.connection &&
      mongoose.connection.readyState === 1 &&
      typeof mongoose.startSession === 'function'
    ) {
      try {
        session = await mongoose.startSession();
        session.startTransaction();
        isTransactionActive = true;
      } catch (startErr) {
        // Fall back cleanly on the specific 'transactions not supported' error
        const msg = (startErr.message || '').toLowerCase();
        const notSupported =
          msg.includes('replica set') ||
          msg.includes('transaction numbers are only allowed') ||
          msg.includes('transactions are not supported') ||
          msg.includes('retryable writes');

        if (session) {
          try {
            await session.endSession();
          } catch {}
          session = null;
        }
        isTransactionActive = false;

        if (!notSupported) {
          throw startErr;
        }
      }
    }

    let savedRun = null;
    let savedClaims = [];

    const runDocData = {
      report: reportId,
      user: userId,
      draft: draft._id,
      githubAnalyses: githubAnalysisIds,
      config: runConfig,
      counts,
      jobId: null,
      createdAt: new Date(),
    };

    const executeNonTransactional = async () => {
      savedRun = await VerificationRun.create(runDocData);

      const claimsToInsert = verifiedClaimData.map((claim) => ({
        ...claim,
        run: savedRun._id,
        report: reportId,
        user: userId,
      }));

      if (claimsToInsert.length > 0) {
        try {
          savedClaims = await ResumeClaim.insertMany(claimsToInsert, { ordered: true });
        } catch (insertErr) {
          await VerificationRun.deleteOne({ _id: savedRun._id });
          await ResumeClaim.deleteMany({ run: savedRun._id });
          throw insertErr;
        }
      }
    };

    try {
      if (isTransactionActive && session) {
        try {
          const createdRuns = await VerificationRun.create([runDocData], { session });
          savedRun = createdRuns[0];

          const claimsToInsert = verifiedClaimData.map((claim) => ({
            ...claim,
            run: savedRun._id,
            report: reportId,
            user: userId,
          }));

          if (claimsToInsert.length > 0) {
            savedClaims = await ResumeClaim.insertMany(claimsToInsert, {
              session,
              ordered: true,
            });
          }

          await session.commitTransaction();
        } catch (txnErr) {
          try {
            await session.abortTransaction();
          } catch {}

          const msg = (txnErr.message || '').toLowerCase();
          const notSupported =
            msg.includes('replica set') ||
            msg.includes('transaction numbers are only allowed') ||
            msg.includes('transactions are not supported') ||
            msg.includes('retryable writes');

          if (notSupported) {
            // Server rejected transaction due to lack of replica set support; fall back to compensation
            isTransactionActive = false;
            await executeNonTransactional();
          } else {
            throw txnErr;
          }
        }
      } else {
        await executeNonTransactional();
      }
    } catch (persistenceErr) {
      if (isTransactionActive && session) {
        try {
          await session.abortTransaction();
        } catch {
          // ignore abort error
        }
      }
      if (logger && typeof logger.error === 'function') {
        logger.error({ err: persistenceErr.message }, 'Persistence failed during verification');
      }
      throw new VerificationError(
        'Failed to persist verification results cleanly',
        503,
        'UPSTREAM_UNAVAILABLE',
        15
      );
    } finally {
      if (session) {
        try {
          await session.endSession();
        } catch {
          // ignore end session error
        }
      }
    }

    return {
      run: savedRun,
      claims: savedClaims,
    };
  }

  return {
    verifyReport,
    verifyOne,
  };
}

module.exports = {
  createVerificationService,
  VerificationError,
};
