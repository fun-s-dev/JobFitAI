const { startGitHubAnalysisJob } = require('../services/jobRunner');
const GithubAnalysis = require('../models/githubAnalysis');
const ReportProjectLink = require('../models/reportProjectLink.model');
const GithubConnection = require('../models/githubConnection.model');
const GithubOauthState = require('../models/githubOauthState.model');
const { InvalidRepoUrlError } = require('../core/parseRepoUrl');
const { UNSUPPORTED } = require('../core/githubRepoClassification');
const { getCfg, isGitHubConnectConfigured } = require('../config/env');
const { createGitHubAppAuth } = require('../adapters/githubAppAuth');
const { createGitHubConnectService, GitHubConnectError } = require('../services/githubConnection.service');
const { logger: defaultLogger } = require('../utils/logger');

const UNSUPPORTED_HTTP = {
  [UNSUPPORTED.PRIVATE]: { status: 422, code: 'PRIVATE_REPOSITORY_UNSUPPORTED' },
  [UNSUPPORTED.NOT_OWNED]: { status: 403, code: 'REPO_NOT_OWNED' },
  [UNSUPPORTED.FORK]: { status: 422, code: 'FORK_UNSUPPORTED' },
  [UNSUPPORTED.ARCHIVED]: { status: 422, code: 'REPO_ARCHIVED' },
  [UNSUPPORTED.DISABLED]: { status: 422, code: 'REPO_DISABLED' },
};

function requestIdOf(req) {
  return req.id || req.headers['x-request-id'] || 'unknown';
}

/** V2 error contract, plus a top-level `message` for the shared frontend error helper. */
function sendError(req, res, status, code, message) {
  return res.status(status).json({ message, error: { code, message, requestId: requestIdOf(req) } });
}

function buildDefaultConnectService() {
  const cfg = getCfg();
  const configured = isGitHubConnectConfigured(cfg);
  return createGitHubConnectService({
    ConnectionModel: GithubConnection,
    StateModel: GithubOauthState,
    authClient: configured
      ? createGitHubAppAuth({
          clientId: cfg.GITHUB_APP_CLIENT_ID,
          clientSecret: cfg.GITHUB_APP_CLIENT_SECRET,
          callbackUrl: cfg.GITHUB_APP_CALLBACK_URL,
        })
      : null,
    encryptionKeyBase64: configured ? cfg.GITHUB_TOKEN_ENC_KEY : null,
    logger: defaultLogger,
  });
}

let activeConnectService = null;
let activeEvidenceService = null; // null = jobRunner's default githubEvidenceService

function getConnectService() {
  if (!activeConnectService) activeConnectService = buildDefaultConnectService();
  return activeConnectService;
}

/** Test hooks (same pattern as setDraftService / setVerificationService). */
function setGithubConnectService(service) {
  activeConnectService = service || null;
}
function setGithubEvidenceService(service) {
  activeEvidenceService = service || null;
}

function frontendBase() {
  let base = 'http://localhost:5173';
  try {
    base = getCfg().FRONTEND_URL || base;
  } catch {
    base = process.env.FRONTEND_URL || base;
  }
  return base.replace(/\/+$/, '');
}

function createGithubController({ jobStarter = startGitHubAnalysisJob, logger = defaultLogger } = {}) {
  function handleConnectError(err, req, res, next) {
    if (err instanceof GitHubConnectError) {
      return sendError(req, res, err.status, err.code, err.message);
    }
    return next(err);
  }

  // GET /api/v2/github/connection
  async function getConnection(req, res, next) {
    try {
      const status = await getConnectService().getStatus(req.user.id);
      res.set('Cache-Control', 'no-store');
      return res.status(200).json({ connection: status, requestId: requestIdOf(req) });
    } catch (err) {
      return handleConnectError(err, req, res, next);
    }
  }

  // POST /api/v2/github/connect/start
  async function startConnect(req, res, next) {
    try {
      const { authorizeUrl } = await getConnectService().startConnect({
        userId: req.user.id,
        returnTo: req.body?.returnTo || '/',
      });
      res.set('Cache-Control', 'no-store');
      return res.status(200).json({ authorizeUrl, requestId: requestIdOf(req) });
    } catch (err) {
      return handleConnectError(err, req, res, next);
    }
  }

  // GET /api/v2/github/connect/callback  (browser redirect from GitHub; always answers with a redirect)
  async function connectCallback(req, res) {
    const asString = (v) => (typeof v === 'string' ? v : undefined);
    const finish = (returnTo, outcome) => {
      const target =
        outcome === 'connected'
          ? `${frontendBase()}${returnTo}${returnTo.includes('?') ? '&' : '?'}github=connected`
          : `${frontendBase()}${returnTo}${returnTo.includes('?') ? '&' : '?'}github=error&reason=${encodeURIComponent(outcome)}`;
      res.set('Cache-Control', 'no-store');
      return res.redirect(302, target);
    };

    try {
      const result = await getConnectService().completeConnect({
        userId: req.user.id,
        code: asString(req.query.code),
        state: asString(req.query.state),
        providerError: asString(req.query.error) || null,
      });
      return finish(result.returnTo, result.outcome);
    } catch (err) {
      if (err instanceof GitHubConnectError) {
        return finish('/', err.code === 'GITHUB_CONNECT_NOT_CONFIGURED' ? 'not_configured' : 'server_error');
      }
      logger.error({ errName: err && err.name }, 'GitHub connect callback failed');
      return finish('/', 'server_error');
    }
  }

  // GET /api/v2/github/repos
  async function listRepos(req, res, next) {
    try {
      const { login, repos } = await getConnectService().listRepositories(req.user.id);
      res.set('Cache-Control', 'no-store');
      return res.status(200).json({
        login,
        repos,
        // Spelled out so the UI never implies more than the identity-only token can see
        scope: {
          visibility: 'public_only',
          ownership: 'owner_only',
          privateRepositories: 'unsupported',
          note: 'Private repositories cannot be listed or analyzed in this version.',
        },
        requestId: requestIdOf(req),
      });
    } catch (err) {
      return handleConnectError(err, req, res, next);
    }
  }

  // DELETE /api/v2/github/connection
  async function disconnect(req, res, next) {
    try {
      const result = await getConnectService().disconnect(req.user.id);
      return res.status(200).json({ ...result, requestId: requestIdOf(req) });
    } catch (err) {
      return handleConnectError(err, req, res, next);
    }
  }

  /**
   * POST /api/v2/github/analyze
   * Body: { reportId, repoUrl }  -> pasted public URL: analysed, ownership NOT verified
   *    or { reportId, repoId }   -> repository from the connected GitHub account: ownership verified
   * Returns 202 Accepted with a job id.
   */
  async function postAnalyzeRepo(req, res, next) {
    const { reportId, repoUrl, repoId } = req.body;
    const userId = req.user._id || req.user.id;

    try {
      let urlToAnalyze = repoUrl;
      let repoControl = { verified: false, method: 'pasted_public_url' };
      let resolveGithubClient = null;

      if (repoId !== undefined) {
        const connectService = getConnectService();
        const { repo, control } = await connectService.resolveRepository(String(userId), repoId);
        if (!repo.selectable || !control) {
          const mapped = UNSUPPORTED_HTTP[repo.unsupportedReason] || { status: 422, code: 'REPO_UNSUPPORTED' };
          return sendError(req, res, mapped.status, mapped.code, repo.unsupportedMessage || 'This repository cannot be analyzed.');
        }
        urlToAnalyze = repo.htmlUrl;
        repoControl = control;
        resolveGithubClient = (id) => connectService.getClientForUser(id);
      }

      const { job, isNew } = await jobStarter({
        userId,
        reportId,
        repoUrl: urlToAnalyze,
        repoControl,
        resolveGithubClient,
        githubEvidenceService: activeEvidenceService || undefined,
      });

      return res.status(202).json({
        jobId: job._id,
        status: job.status,
        isNew,
        ownershipVerified: repoControl.verified === true,
        message: 'GitHub analysis job queued',
        requestId: requestIdOf(req),
      });
    } catch (err) {
      if (err instanceof InvalidRepoUrlError) {
        return sendError(req, res, 400, 'INVALID_REPO_URL', err.message);
      }
      return handleConnectError(err, req, res, next);
    }
  }

  /**
   * GET /api/v2/github/analysis/:analysisId
   * Fetches analysis record if owned/linked by the authenticated user.
   * Returns 404 (not 403) when not owned.
   */
  async function getAnalysisById(req, res, next) {
    const { analysisId } = req.params;
    const userId = req.user._id || req.user.id;

    try {
      const links = await ReportProjectLink.find({ analysisId, user: userId });
      if (!links || links.length === 0) {
        return sendError(req, res, 404, 'NOT_FOUND', 'GitHub analysis not found');
      }

      const analysis = await GithubAnalysis.findById(analysisId);
      if (!analysis) {
        return sendError(req, res, 404, 'NOT_FOUND', 'GitHub analysis not found');
      }

      const verifiedLink = links.find((l) => l.control && l.control.verified === true);
      const control = verifiedLink ? verifiedLink.control : { verified: false, method: 'pasted_public_url' };

      return res.status(200).json({
        analysis,
        // Repository CONTROL evidence; authorship is never assessed
        control: {
          verified: control.verified === true,
          method: control.method,
          githubLogin: control.githubLogin || null,
        },
        authorship: 'not_assessed',
        requestId: requestIdOf(req),
      });
    } catch (err) {
      return next(err);
    }
  }

  return { getConnection, startConnect, connectCallback, listRepos, disconnect, postAnalyzeRepo, getAnalysisById };
}

const defaultController = createGithubController();

/**
 * Used by account deletion: revoke at GitHub (best effort) and remove the stored connection.
 * Works when GitHub Connect is not configured too (a leftover record is simply deleted).
 */
async function disconnectGithubForUser(userId) {
  const service = getConnectService();
  if (service.isConfigured()) {
    await service.disconnect(userId);
  } else {
    await GithubConnection.deleteMany({ user: userId });
    await GithubOauthState.deleteMany({ user: userId });
  }
}

module.exports = {
  createGithubController,
  setGithubConnectService,
  setGithubEvidenceService,
  disconnectGithubForUser,
  getConnection: defaultController.getConnection,
  startConnect: defaultController.startConnect,
  connectCallback: defaultController.connectCallback,
  listRepos: defaultController.listRepos,
  disconnect: defaultController.disconnect,
  postAnalyzeRepo: defaultController.postAnalyzeRepo,
  getAnalysisById: defaultController.getAnalysisById,
};
