const ResumeClaim = require('../models/resumeClaim.model');
const VerificationRun = require('../models/verificationRun.model');
const InterviewReport = require('../../models/interviewReport.model');
const { createVerificationService, VerificationError } = require('../services/verification.service');
const { createLlmClient } = require('../adapters/llmClient');
const { createDraftService } = require('../services/draft.service');
const { createClaimExtractionService } = require('../services/claimExtraction.service');
const { createEvidenceMatchingService } = require('../services/evidenceMatching.service');
const { createEntailmentService } = require('../services/entailment.service');

// Default instances
const defaultLlmClient = createLlmClient();
const defaultVerificationService = createVerificationService({
  llmClient: defaultLlmClient,
  draftService: createDraftService({ llmClient: defaultLlmClient }),
  claimExtractionService: createClaimExtractionService({ llmClient: defaultLlmClient }),
  evidenceMatchingService: createEvidenceMatchingService({ llmClient: defaultLlmClient }),
  entailmentService: createEntailmentService({ llmClient: defaultLlmClient }),
});

let activeVerificationService = defaultVerificationService;
let activeSyncMode = false;

function setVerificationService(service) {
  activeVerificationService = service || defaultVerificationService;
}

function setVerificationSyncMode(enabled = false) {
  activeSyncMode = Boolean(enabled);
}

function createVerificationController({
  verificationService = null,
  claimModel = ResumeClaim,
  runModel = VerificationRun,
  reportModel = InterviewReport,
  syncMode = null,
} = {}) {
  /**
   * POST /api/v2/verification/:reportId
   * Runs verification for an owned interview report. Returns 202 { jobId } by default,
   * or 200 { run, claims } when sync flag is enabled (query, body, or test controller flag).
   */
  async function postVerifyReport(req, res, next) {
    const requestId = req.id || req.headers['x-request-id'] || 'unknown';
    try {
      const reportId = req.params.reportId;
      const userId = req.user ? (req.user._id || req.user.id) : null;
      const { draftId = null, githubAnalysisIds = [], sync: bodySync } = req.body || {};
      const querySync = req.query?.sync === true || req.query?.sync === 'true';
      const isSync =
        bodySync === true ||
        querySync ||
        (syncMode !== null ? syncMode : activeSyncMode);

      const serviceToUse = verificationService || activeVerificationService;

      if (isSync) {
        const result = await serviceToUse.verifyReport({
          reportId,
          userId: String(userId),
          draftId,
          githubAnalysisIds,
        });

        return res.status(200).json({
          run: result.run,
          claims: result.claims,
          requestId,
        });
      }

      // Async background job (202 Accepted)
      const { startVerificationJob } = require('../services/jobRunner');
      const { job } = await startVerificationJob({
        userId: String(userId),
        reportId,
        verificationService: serviceToUse,
      });

      return res.status(202).json({
        message: 'Verification job initiated',
        jobId: job._id,
        status: job.status,
        progress: job.progress,
        requestId,
      });
    } catch (err) {
      if (err instanceof VerificationError || (err.status && err.code)) {
        if (err.retryAfter) {
          res.setHeader('Retry-After', String(err.retryAfter));
        }
        return res.status(err.status || 500).json({
          error: {
            code: err.code || 'VERIFICATION_ERROR',
            message: err.message,
            retryAfter: err.retryAfter || undefined,
            requestId,
          },
        });
      }
      next(err);
    }
  }

  /**
   * GET /api/v2/verification/:reportId
   * Fetches latest (or specific runId) verification run and its claims.
   */
  async function getReportVerification(req, res, next) {
    const requestId = req.id || req.headers['x-request-id'] || 'unknown';
    try {
      const reportId = req.params.reportId;
      const userId = req.user ? (req.user._id || req.user.id) : null;
      const runId = req.query.runId;

      let run = null;
      if (runId) {
        run = await runModel.findOne({ _id: runId, report: reportId, user: userId });
      } else {
        run = await runModel.findOne({ report: reportId, user: userId }).sort({ createdAt: -1 });
      }

      if (!run) {
        return res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: 'No verification run found for this report',
            requestId,
          },
        });
      }

      const claims = await claimModel
        .find({ run: run._id, report: reportId, user: userId })
        .sort({ createdAt: 1 });

      return res.status(200).json({
        run,
        claims,
        requestId,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/v2/verification/claim/:claimId
   * Updates userOverride on a claim after verifying ownership through the parent report.
   * Automated status remains immutable.
   */
  async function patchClaimOverride(req, res, next) {
    const requestId = req.id || req.headers['x-request-id'] || 'unknown';
    try {
      const claimId = req.params.claimId;
      const userId = req.user ? (req.user._id || req.user.id) : null;
      const { decision } = req.body;

      const claim = await claimModel.findById(claimId);
      if (!claim) {
        return res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: 'Claim not found',
            requestId,
          },
        });
      }

      // Check ownership via the claim's parent report (IDOR defense)
      const report = await reportModel.findOne({ _id: claim.report, user: userId });
      if (!report) {
        return res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: 'Claim not found',
            requestId,
          },
        });
      }

      // Update userOverride only; automated status remains untouched
      claim.userOverride = {
        decision,
        at: new Date(),
      };

      await claim.save();

      return res.status(200).json({
        message: 'Claim decision updated successfully',
        claim,
        effectiveStatus: claim.userOverride.decision,
        requestId,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v2/verification/claim/:claimId (and /claims/:claimId)
   * Fetches an individual claim after verifying ownership through the parent report.
   */
  async function getClaimById(req, res, next) {
    const requestId = req.id || req.headers['x-request-id'] || 'unknown';
    try {
      const claimId = req.params.claimId;
      const userId = req.user ? (req.user._id || req.user.id) : null;

      const claim = await claimModel.findById(claimId);
      if (!claim) {
        return res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: 'Claim not found',
            requestId,
          },
        });
      }

      const report = await reportModel.findOne({ _id: claim.report, user: userId });
      if (!report) {
        return res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: 'Claim not found',
            requestId,
          },
        });
      }

      return res.status(200).json({
        claim,
        requestId,
      });
    } catch (err) {
      next(err);
    }
  }

  return {
    postVerifyReport,
    getReportVerification,
    patchClaimOverride,
    getClaimById,
  };
}

const defaultController = createVerificationController();

module.exports = {
  createVerificationController,
  postVerifyReport: defaultController.postVerifyReport,
  getReportVerification: defaultController.getReportVerification,
  patchClaimOverride: defaultController.patchClaimOverride,
  getClaimById: defaultController.getClaimById,
  setVerificationService,
  setVerificationSyncMode,
};
