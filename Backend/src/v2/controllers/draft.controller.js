const ResumeDraft = require('../models/resumeDraft.model');
const { createDraftService } = require('../services/draft.service');
const { createLlmClient } = require('../adapters/llmClient');

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

  return {
    createDraft,
    getLatestDraft,
  };
}

const defaultController = createDraftController();

module.exports = {
  createDraftController,
  createDraft: defaultController.createDraft,
  getLatestDraft: defaultController.getLatestDraft,
  setDraftService,
};

