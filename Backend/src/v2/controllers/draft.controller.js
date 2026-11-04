const ResumeDraft = require('../models/resumeDraft.model');
const VerificationRun = require('../models/verificationRun.model');
const ResumeClaim = require('../models/resumeClaim.model');
const ReportProjectLink = require('../models/reportProjectLink.model');
const RepoRanking = require('../models/repoRanking.model');
const GithubAnalysis = require('../models/githubAnalysis');
const { createDraftService } = require('../services/draft.service');
const { createProjectDraftService } = require('../services/projectDraft.service');
const { createLlmClient } = require('../adapters/llmClient');
const pdfRenderer = require('../adapters/pdfRenderer');
const { renderDraftToHtml } = require('../templates/resumePdfTemplate');
const { buildGroundedExport } = require('../core/groundedExport');
const { applyGithubProjectRules } = require('../core/githubProjects');
const { applyResumeExtras } = require('../core/resumeExtras');
const { getCfg } = require('../config/env');

// One client for the draft and the GitHub project bullets, so their calls share one pacer
const sharedLlmClient = createLlmClient();
const defaultDraftService = createDraftService({
  llmClient: sharedLlmClient,
});
const defaultProjectDraftService = createProjectDraftService({
  llmClient: sharedLlmClient,
  RankingModel: RepoRanking,
  LinkModel: ReportProjectLink,
  AnalysisModel: GithubAnalysis,
});

let activeDraftService = defaultDraftService;
let activeProjectDraftService = defaultProjectDraftService;

function setDraftService(service) {
  activeDraftService = service || defaultDraftService;
}

/** Test hook (same pattern as setDraftService). */
function setProjectDraftService(service) {
  activeProjectDraftService = service || defaultProjectDraftService;
}

class ExportError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ExportError';
    this.status = status;
    this.code = code;
  }
}

function errorBody(code, message, requestId) {
  return { error: { code, message, requestId } };
}

function toPlainDraft(draftRecord) {
  const doc = typeof draftRecord.toObject === 'function' ? draftRecord.toObject() : draftRecord;
  return doc.draft || {};
}

function createDraftController({
  draftService = null,
  projectDraftService = null,
  linkModel = ReportProjectLink,
  draftModel = ResumeDraft,
  runModel = VerificationRun,
  claimModel = ResumeClaim,
  renderer = pdfRenderer,
  configGetter = getCfg,
} = {}) {
  /**
   * Loads everything an export needs, bound to ONE consistent draft:
   * - With a verification run (latest, or `runId`), the export uses the draft that run verified.
   *   Using the latest draft instead would be wrong: bullet IDs are positional (exp0.b0, ...),
   *   so claims from an older draft would approve unverified bullets of a newer draft.
   * - Without any run, the latest draft is used and every bullet is excluded ("not verified").
   *
   * @throws {ExportError} 404 when the run, its draft, or any draft is missing
   */
  async function loadExportContext(report, userId, runId) {
    let run = null;
    if (runId) {
      run = await runModel.findOne({ _id: runId, report: report._id, user: userId });
      if (!run) {
        throw new ExportError(404, 'RUN_NOT_FOUND', 'Verification run not found for this report');
      }
    } else {
      run = await runModel.findOne({ report: report._id, user: userId }).sort({ createdAt: -1 });
    }

    const latestDraft = await draftModel
      .findOne({ report: report._id, user: userId })
      .sort({ createdAt: -1 });

    let draftRecord = latestDraft;
    if (run) {
      draftRecord = await draftModel.findOne({ _id: run.draft, report: report._id, user: userId });
      if (!draftRecord) {
        throw new ExportError(
          404,
          'DRAFT_NOT_FOUND',
          'The draft verified by this run no longer exists. Generate a draft and run verification again.'
        );
      }
    }

    if (!draftRecord || !draftRecord.draft) {
      throw new ExportError(404, 'NOT_FOUND', 'No draft found for this report');
    }

    const claims = run
      ? await claimModel.find({ run: run._id, report: report._id, user: userId })
      : [];

    const plainDraft = toPlainDraft(draftRecord);
    const grounded = buildGroundedExport(plainDraft, claims, [
      report.resume || '',
      report.selfDescription || '',
    ]);

    // GitHub projects are exported only after the user confirmed they built them, under the name they chose
    // Projects tied to one of the user's repositories: chosen name, repository link, and (for projects
    // written from a repository) the "I built this" gate. Only looked up when the draft has projects.
    if ((plainDraft.projects || []).length > 0) {
      const links = await linkModel.find({ report: report._id, user: userId });
      const applied = applyGithubProjectRules({ draft: plainDraft, exportDraft: grounded.exportDraft, links });
      grounded.exportDraft = applied.exportDraft;
      grounded.excludedItems = [...grounded.excludedItems, ...applied.excludedItems];
    }

    // Links, certifications and grade copied from the resume itself (deterministic, never AI-written)
    grounded.exportDraft = applyResumeExtras({ exportDraft: grounded.exportDraft, extras: report.resumeExtras });

    return {
      run,
      draftRecord,
      latestDraft,
      // null = nothing verified yet; false = a newer draft exists than the one this run verified
      isLatestDraftVerified: run
        ? Boolean(latestDraft && String(latestDraft._id) === String(run.draft))
        : null,
      grounded,
    };
  }

  function handleExportError(err, res, next, requestId) {
    if (err instanceof ExportError) {
      return res.status(err.status).json(errorBody(err.code, err.message, requestId));
    }
    return next(err);
  }

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
      const projectService = projectDraftService || activeProjectDraftService;

      // The tailored resume and the GitHub projects are independent, so they are produced together.
      // A failure while writing GitHub projects never loses the draft: the resume's own projects stay
      // and the response says what went wrong.
      const buildGithubProjects = async () => {
        try {
          return await projectService.buildGithubProjects({ userId: String(userId), reportId: String(report._id), requestId });
        } catch (projErr) {
          return { configured: true, projects: [], skipped: [], error: projErr };
        }
      };
      const [draft, github] = await Promise.all([
        serviceToUse.generateDraft({
          resume: report.resume || '',
          selfDescription: report.selfDescription || '',
          jobDescription: report.jobDescription || '',
          user: String(userId),
          requestId,
        }),
        buildGithubProjects(),
      ]);

      // The Projects section comes from the selected GitHub repositories when there are any
      if (github.projects.length > 0) {
        draft.projects = github.projects;
      }
      const githubProjects = {
        configured: github.configured,
        used: github.projects.map((p) => ({ name: p.name, repo: p.repoFullName })),
        skipped: github.skipped,
        error: github.error ? github.error.message || 'GitHub projects could not be written.' : null,
      };

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
        githubProjects,
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
        return res.status(404).json(errorBody('NOT_FOUND', 'No draft found for this report', requestId));
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
   * containing only grounded content (see buildGroundedExport).
   */
  async function getPrintDraft(req, res, next) {
    const requestId = req.id || req.headers['x-request-id'] || 'unknown';
    try {
      const userId = req.user._id || req.user.id;
      const { runId } = req.query || {};
      const { grounded } = await loadExportContext(req.report, userId, runId);

      const html = renderDraftToHtml(grounded.exportDraft);

      // Strict CSP: script-free, no external network resources
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; script-src 'none'; frame-ancestors 'none'; form-action 'none';"
      );
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(html);
    } catch (err) {
      return handleExportError(err, res, next, requestId);
    }
  }

  /**
   * POST /api/v2/drafts/:reportId/pdf
   * Uses pdfRenderer to render the grounded PDF. Enabled only when PDF_RENDERING_ENABLED=true.
   * When false, returns 501. When Chromium is missing or fails to launch, returns 503.
   * Both errors tell the user to use the print view instead.
   */
  async function renderDraftPdf(req, res, next) {
    const requestId = req.id || req.headers['x-request-id'] || 'unknown';
    try {
      let cfg;
      try {
        cfg = configGetter();
      } catch {
        cfg = { PDF_RENDERING_ENABLED: true };
      }

      if (!cfg.PDF_RENDERING_ENABLED) {
        return res
          .status(501)
          .json(
            errorBody(
              'NOT_IMPLEMENTED',
              'Server-side PDF rendering is disabled. Use the Print / Save as PDF button in the browser.',
              requestId
            )
          );
      }

      const userId = req.user._id || req.user.id;
      const runId = req.body?.runId || req.query?.runId;
      const { grounded } = await loadExportContext(req.report, userId, runId);

      let pdfBuffer;
      try {
        pdfBuffer = await renderer.renderDraftToPdf(grounded.exportDraft, {
          noSandbox: cfg.PUPPETEER_NO_SANDBOX,
        });
      } catch (renderErr) {
        if (req.log && typeof req.log.error === 'function') {
          req.log.error({ err: renderErr, requestId }, 'PDF rendering failed');
        }
        return res
          .status(503)
          .json(
            errorBody(
              'PDF_RENDERER_UNAVAILABLE',
              'Server-side PDF rendering is unavailable right now. Use Print / Save as PDF instead.',
              requestId
            )
          );
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="tailored-resume.pdf"');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(pdfBuffer);
    } catch (err) {
      return handleExportError(err, res, next, requestId);
    }
  }

  /**
   * GET /api/v2/drafts/:reportId/grounded?runId=
   * Returns the grounded export breakdown for the UI: included/excluded bullets with reasons,
   * excluded non-bullet items (summary, skills, education, header) and review warnings.
   */
  async function getGroundedDraftInfo(req, res, next) {
    const requestId = req.id || req.headers['x-request-id'] || 'unknown';
    try {
      const userId = req.user._id || req.user.id;
      const { runId } = req.query || {};
      const { run, draftRecord, latestDraft, isLatestDraftVerified, grounded } =
        await loadExportContext(req.report, userId, runId);

      return res.status(200).json({
        draft: draftRecord.draft,
        draftId: draftRecord._id,
        latestDraftId: latestDraft?._id || null,
        isLatestDraftVerified,
        runId: run?._id || null,
        allowedBulletIds: grounded.allowedBulletIds,
        excludedBulletIds: grounded.excludedBulletIds,
        excludedBullets: grounded.excludedBullets,
        excludedItems: grounded.excludedItems,
        warnings: grounded.warnings,
        requestId,
      });
    } catch (err) {
      return handleExportError(err, res, next, requestId);
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
  setProjectDraftService,
};
