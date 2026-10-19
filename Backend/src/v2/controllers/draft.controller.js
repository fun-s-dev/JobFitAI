const ResumeDraft = require('../models/resumeDraft.model');
const VerificationRun = require('../models/verificationRun.model');
const ResumeClaim = require('../models/resumeClaim.model');
const { createDraftService } = require('../services/draft.service');
const { createLlmClient } = require('../adapters/llmClient');
const pdfRenderer = require('../adapters/pdfRenderer');
const { renderDraftToHtml } = require('../templates/resumePdfTemplate');
const { filterGroundedDraft } = require('../core/groundedExport');
const { getCfg } = require('../config/env');

const defaultDraftService = createDraftService({
  llmClient: createLlmClient(),
});

let activeDraftService = defaultDraftService;

function setDraftService(service) {
  activeDraftService = service || defaultDraftService;
}

function createDraftController({
  draftService = null,
  draftModel = ResumeDraft,
  runModel = VerificationRun,
  claimModel = ResumeClaim,
  renderer = pdfRenderer,
} = {}) {
  /**
   * POST /api/v2/drafts/:reportId
   * Tailors a new ResumeDraft for an owned interview report and saves it.
   */
  async function createDraft(req, res, next) {
    const requestId = req.id || req.headers['x-request-id'] || 'unknown';
    try {
      const report = req.report;
      const userId = req.user._id || req.user.id;
      const serviceToUse = draftService || activeDraftService;

      const draft = await serviceToUse.generateDraft({
        resume: report.resume || '',
        selfDescription: report.selfDescription || '',
        jobDescription: report.jobDescription || '',
        user: String(userId),
        requestId,
      });

      // Get current version count for this report
      const latestCount = await draftModel.countDocuments({ report: report._id, user: userId });

      const savedDraft = await draftModel.create({
        report: report._id,
        user: userId,
        draft,
        version: latestCount + 1,
      });

      return res.status(201).json({
        message: 'Resume draft created successfully',
        draft: savedDraft.draft,
        draftId: savedDraft._id,
        version: savedDraft.version,
        requestId,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v2/drafts/:reportId
   * Fetches the latest saved ResumeDraft for an owned interview report.
   */
  async function getLatestDraft(req, res, next) {
    const requestId = req.id || req.headers['x-request-id'] || 'unknown';
    try {
      const report = req.report;
      const userId = req.user._id || req.user.id;

      const latest = await draftModel
        .findOne({ report: report._id, user: userId })
        .sort({ createdAt: -1 });

      if (!latest) {
        return res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: 'No draft found for this report',
            requestId,
          },
        });
      }

      return res.status(200).json({
        message: 'Resume draft fetched successfully',
        draft: latest.draft,
        draftId: latest._id,
        version: latest.version,
        createdAt: latest.createdAt,
        requestId,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v2/drafts/:reportId/print?runId=
   * Returns a self-contained, escaped, script-free HTML page with strict CSP
   * containing only allowed (verified/approved) bullets.
   */
  async function getPrintDraft(req, res, next) {
    const requestId = req.id || req.headers['x-request-id'] || 'unknown';
    try {
      const report = req.report;
      const userId = req.user._id || req.user.id;
      const { runId } = req.query || {};

      const draftRecord = await draftModel
        .findOne({ report: report._id, user: userId })
        .sort({ createdAt: -1 });

      if (!draftRecord || !draftRecord.draft) {
        return res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: 'No draft found for this report',
            requestId,
          },
        });
      }

      let run = null;
      if (runId) {
        run = await runModel.findOne({ _id: runId, report: report._id, user: userId });
      } else {
        run = await runModel.findOne({ report: report._id, user: userId }).sort({ createdAt: -1 });
      }

      let claims = [];
      if (run) {
        claims = await claimModel.find({ run: run._id, report: report._id, user: userId });
      }

      const { excludedBulletIds } = filterGroundedDraft(draftRecord.draft, claims);
      const html = renderDraftToHtml(draftRecord.draft, { excludedBulletIds });

      // Strict CSP: script-free, no external network resources
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; script-src 'none'; frame-ancestors 'none'; form-action 'none';"
      );
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v2/drafts/:reportId/pdf
   * Uses pdfRenderer to render grounded PDF. Enabled only when PDF_RENDERING_ENABLED=true.
   * When false, returns 501 Not Implemented with a clear message.
   */
  async function renderDraftPdf(req, res, next) {
    const requestId = req.id || req.headers['x-request-id'] || 'unknown';
    try {
      let cfg;
      try {
        cfg = getCfg();
      } catch {
        cfg = { PDF_RENDERING_ENABLED: true };
      }

      if (!cfg.PDF_RENDERING_ENABLED) {
        return res.status(501).json({
          error: {
            code: 'NOT_IMPLEMENTED',
            message: 'Server-side PDF rendering is disabled. Use the Print / Save as PDF button in the browser.',
            requestId,
          },
        });
      }

      const report = req.report;
      const userId = req.user._id || req.user.id;
      const runId = req.body?.runId || req.query?.runId;

      const draftRecord = await draftModel
        .findOne({ report: report._id, user: userId })
        .sort({ createdAt: -1 });

      if (!draftRecord || !draftRecord.draft) {
        return res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: 'No draft found for this report',
            requestId,
          },
        });
      }

      let run = null;
      if (runId) {
        run = await runModel.findOne({ _id: runId, report: report._id, user: userId });
      } else {
        run = await runModel.findOne({ report: report._id, user: userId }).sort({ createdAt: -1 });
      }

      let claims = [];
      if (run) {
        claims = await claimModel.find({ run: run._id, report: report._id, user: userId });
      }

      const { excludedBulletIds } = filterGroundedDraft(draftRecord.draft, claims);

      const pdfBuffer = await renderer.renderDraftToPdf(draftRecord.draft, {
        excludedBulletIds,
        noSandbox: cfg.PUPPETEER_NO_SANDBOX,
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="tailored-resume.pdf"');
      return res.status(200).send(pdfBuffer);
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v2/drafts/:reportId/grounded
   * Returns grounded draft breakdown (allowed vs excluded bullets with reasons) for the UI.
   */
  async function getGroundedDraftInfo(req, res, next) {
    const requestId = req.id || req.headers['x-request-id'] || 'unknown';
    try {
      const report = req.report;
      const userId = req.user._id || req.user.id;
      const { runId } = req.query || {};

      const draftRecord = await draftModel
        .findOne({ report: report._id, user: userId })
        .sort({ createdAt: -1 });

      if (!draftRecord || !draftRecord.draft) {
        return res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: 'No draft found for this report',
            requestId,
          },
        });
      }

      let run = null;
      if (runId) {
        run = await runModel.findOne({ _id: runId, report: report._id, user: userId });
      } else {
        run = await runModel.findOne({ report: report._id, user: userId }).sort({ createdAt: -1 });
      }

      let claims = [];
      if (run) {
        claims = await claimModel.find({ run: run._id, report: report._id, user: userId });
      }

      const grounded = filterGroundedDraft(draftRecord.draft, claims);

      return res.status(200).json({
        draft: draftRecord.draft,
        draftId: draftRecord._id,
        runId: run?._id || null,
        allowedBulletIds: grounded.allowedBulletIds,
        excludedBulletIds: grounded.excludedBulletIds,
        excludedBullets: grounded.excludedBullets,
        requestId,
      });
    } catch (err) {
      next(err);
    }
  }

  return {
    createDraft,
    getLatestDraft,
    getPrintDraft,
    renderDraftPdf,
    getGroundedDraftInfo,
  };
}

const defaultController = createDraftController();

module.exports = {
  createDraftController,
  createDraft: defaultController.createDraft,
  getLatestDraft: defaultController.getLatestDraft,
  getPrintDraft: defaultController.getPrintDraft,
  renderDraftPdf: defaultController.renderDraftPdf,
  getGroundedDraftInfo: defaultController.getGroundedDraftInfo,
  setDraftService,
};
