const { startGitHubAnalysisJob } = require('../services/jobRunner');
const GithubAnalysis = require('../models/githubAnalysis');
const ReportProjectLink = require('../models/reportProjectLink.model');
const { InvalidRepoUrlError } = require('../core/parseRepoUrl');

/**
 * POST /api/v2/github/analyze
 * Body: { reportId: string, repoUrl: string }
 * Starts a background GitHub analysis job. Returns 202 Accepted.
 */
async function postAnalyzeRepo(req, res, next) {
  const requestId = req.id || req.headers['x-request-id'] || 'unknown';
  const { reportId, repoUrl } = req.body;
  const userId = req.user._id || req.user.id;

  try {
    const { job, isNew } = await startGitHubAnalysisJob({
      userId,
      reportId,
      repoUrl,
    });

    return res.status(202).json({
      jobId: job._id,
      status: job.status,
      isNew,
      message: 'GitHub analysis job queued',
      requestId,
    });
  } catch (err) {
    if (err instanceof InvalidRepoUrlError) {
      return res.status(400).json({
        error: {
          code: 'INVALID_REPO_URL',
          message: err.message,
          requestId,
        },
      });
    }
    next(err);
  }
}

/**
 * GET /api/v2/github/analysis/:analysisId
 * Fetches analysis record if owned/linked by the authenticated user.
 * Returns 404 (not 403) when not owned.
 */
async function getAnalysisById(req, res, next) {
  const requestId = req.id || req.headers['x-request-id'] || 'unknown';
  const { analysisId } = req.params;
  const userId = req.user._id || req.user.id;

  try {
    // Ownership check via ReportProjectLink
    const link = await ReportProjectLink.findOne({ analysisId, user: userId });
    if (!link) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'GitHub analysis not found',
          requestId,
        },
      });
    }

    const analysis = await GithubAnalysis.findById(analysisId);
    if (!analysis) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'GitHub analysis not found',
          requestId,
        },
      });
    }

    return res.status(200).json({
      analysis,
      requestId,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  postAnalyzeRepo,
  getAnalysisById,
};
