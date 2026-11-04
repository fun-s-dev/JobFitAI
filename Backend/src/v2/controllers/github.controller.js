const { startGitHubAnalysisJob, startRepoRankingJob } = require('../services/jobRunner');
const RepoRanking = require('../models/repoRanking.model');
const InterviewReport = require('../../models/interviewReport.model');
const { createRepoRankingService, RankingError } = require('../services/repoRanking.service');
const { createJobRequirementsService } = require('../services/jobRequirements.service');
const { githubEvidenceService: defaultGithubEvidenceService, buildLinkUpdate } = require('../services/githubEvidence.service');
const GithubAnalysis = require('../models/githubAnalysis');
const ReportProjectLink = require('../models/reportProjectLink.model');
const GithubConnection = require('../models/githubConnection.model');
const GithubOauthState = require('../models/githubOauthState.model');
const ResumeDraft = require('../models/resumeDraft.model');
const { resolveProjectForRepo, normalizeProjectKey } = require('../core/projectMatching');
const { defaultProjectName, sanitizeDisplayName } = require('../core/githubProjects');
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
let activeRankingService = null;

function getConnectService() {
  if (!activeConnectService) activeConnectService = buildDefaultConnectService();
  return activeConnectService;
}

function buildDefaultRankingService() {
  // Lazy: building the LLM client needs GOOGLE_GENAI_API_KEY
  const { createLlmClient } = require('../adapters/llmClient');
  const llmClient = createLlmClient();
  let cfg = {};
  try {
    cfg = getCfg();
  } catch {
    cfg = {};
  }
  return createRepoRankingService({
    connectService: getConnectService(),
    githubEvidenceService: activeEvidenceService || defaultGithubEvidenceService,
    llmClient,
    requirementsService: createJobRequirementsService({ llmClient }),
    RankingModel: RepoRanking,
    ReportModel: InterviewReport,
    LinkModel: ReportProjectLink,
    buildLinkUpdate,
    cfg,
    logger: defaultLogger,
  });
}

function getRankingService() {
  if (!activeRankingService) activeRankingService = buildDefaultRankingService();
  return activeRankingService;
}

/** Test hooks (same pattern as setDraftService / setVerificationService). */
function setGithubConnectService(service) {
  activeConnectService = service || null;
}
function setGithubEvidenceService(service) {
  activeEvidenceService = service || null;
}
function setRepoRankingService(service) {
  activeRankingService = service || null;
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

function createGithubController({
  jobStarter = startGitHubAnalysisJob,
  rankingJobStarter = startRepoRankingJob,
  logger = defaultLogger,
} = {}) {
  function handleConnectError(err, req, res, next) {
    if (err instanceof GitHubConnectError) {
      return sendError(req, res, err.status, err.code, err.message);
    }
    if (err instanceof RankingError) {
      return sendError(req, res, err.status, err.code, err.message);
    }
    return next(err);
  }

  // POST /api/v2/github/ranking/:reportId  -> 202 { jobId }  (analyse + rank the user's repositories)
  async function startRanking(req, res, next) {
    const userId = req.user._id || req.user.id;
    try {
      const status = await getConnectService().getStatus(String(userId));
      if (!status || status.configured === false || !status.connected) {
        return sendError(req, res, 409, 'GITHUB_NOT_CONNECTED', 'Connect GitHub first, then find your best projects.');
      }
      const { job, isNew } = await rankingJobStarter({
        userId,
        reportId: String(req.report._id),
        rankingService: getRankingService(),
      });
      return res.status(202).json({
        jobId: job._id,
        status: job.status,
        isNew,
        message: 'Repository ranking job queued',
        requestId: requestIdOf(req),
      });
    } catch (err) {
      return handleConnectError(err, req, res, next);
    }
  }

  // GET /api/v2/github/ranking/:reportId  -> { ranking | null, topN }
  async function getReportRanking(req, res, next) {
    const userId = req.user._id || req.user.id;
    try {
      const ranking = await getRankingService().getRanking({ userId, reportId: req.report._id });
      let topN = 4;
      try {
        topN = getCfg().RANKING_TOP_N || topN;
      } catch {
        // keep default
      }
      res.set('Cache-Control', 'no-store');
      return res.status(200).json({
        ranking: ranking ? (typeof ranking.toObject === 'function' ? ranking.toObject() : ranking) : null,
        topN,
        requestId: requestIdOf(req),
      });
    } catch (err) {
      return handleConnectError(err, req, res, next);
    }
  }

  // PUT /api/v2/github/ranking/:reportId/selection  body: { repoIds }
  async function putRankingSelection(req, res, next) {
    const userId = req.user._id || req.user.id;
    try {
      const ranking = await getRankingService().confirmSelection({
        userId,
        reportId: req.report._id,
        repoIds: req.body.repoIds,
      });
      return res.status(200).json({
        selectedRepoIds: ranking.selectedRepoIds,
        selectionConfirmedAt: ranking.selectionConfirmedAt,
        requestId: requestIdOf(req),
      });
    } catch (err) {
      return handleConnectError(err, req, res, next);
    }
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
   * Body: { reportId, repoId } -> a repository from the connected GitHub account. Ownership is
   * verified server-side from GitHub's response. Pasted URLs are not accepted.
   * Returns 202 Accepted with a job id.
   */
  async function postAnalyzeRepo(req, res, next) {
    const { reportId, repoId } = req.body;
    const userId = req.user._id || req.user.id;

    try {
      const connectService = getConnectService();
      const { repo, control } = await connectService.resolveRepository(String(userId), repoId);
      if (!repo.selectable || !control) {
        const mapped = UNSUPPORTED_HTTP[repo.unsupportedReason] || { status: 422, code: 'REPO_UNSUPPORTED' };
        return sendError(req, res, mapped.status, mapped.code, repo.unsupportedMessage || 'This repository cannot be analyzed.');
      }

      const { job, isNew } = await jobStarter({
        userId,
        reportId,
        repoUrl: repo.htmlUrl,
        repoControl: control,
        resolveGithubClient: (id) => connectService.getClientForUser(id),
        githubEvidenceService: activeEvidenceService || undefined,
      });

      return res.status(202).json({
        jobId: job._id,
        status: job.status,
        isNew,
        ownershipVerified: control.verified === true,
        message: 'GitHub analysis job queued',
        requestId: requestIdOf(req),
      });
    } catch (err) {
      return handleConnectError(err, req, res, next);
    }
  }

  /** Project names of the latest draft of a report ([] when there is no draft yet). */
  async function latestDraftProjects(reportId, userId) {
    const latest = await ResumeDraft.findOne({ report: reportId, user: userId }).sort({ createdAt: -1 }).lean();
    const projects = latest && latest.draft && Array.isArray(latest.draft.projects) ? latest.draft.projects : [];
    return { hasDraft: Boolean(latest && latest.draft), projects };
  }

  /** Analysis ids of the repositories the user confirmed for this report (the GitHub projects). */
  async function selectedAnalysisIds(reportId, userId) {
    const ranking = await RepoRanking.findOne({ report: reportId, user: userId }).lean();
    if (!ranking || !ranking.selectionConfirmedAt) return new Set();
    const chosen = new Set(ranking.selectedRepoIds || []);
    return new Set(
      (ranking.repos || []).filter((r) => chosen.has(r.repoId) && r.analysisId).map((r) => String(r.analysisId))
    );
  }

  // GET /api/v2/github/links/:reportId
  // The repositories linked to this report (persisted), which draft project each one belongs to,
  // and the draft's project names the user can choose from.
  async function listReportLinks(req, res, next) {
    const userId = req.user._id || req.user.id;
    try {
      const reportId = req.report._id;
      const links = await ReportProjectLink.find({ report: reportId, user: userId }).lean();
      const analyses = await GithubAnalysis.find({ _id: { $in: links.map((l) => l.analysisId) } })
        .select('repositoryFullName repositoryUrl')
        .lean();
      const nameById = new Map(analyses.map((a) => [String(a._id), a]));
      const { hasDraft, projects } = await latestDraftProjects(reportId, userId);
      const selected = await selectedAnalysisIds(reportId, userId);

      const rows = links.map((link) => {
        const analysis = nameById.get(String(link.analysisId));
        const repositoryFullName = analysis ? analysis.repositoryFullName : link.repoUrl;
        const verified = Boolean(link.control && link.control.verified === true);
        const { index, source } = resolveProjectForRepo({
          explicitProjectName: link.projectName || null,
          repositoryFullName,
          projects,
        });
        return {
          analysisId: String(link.analysisId),
          repositoryFullName,
          verified,
          explicitProjectName: link.projectName || null,
          matchedProject: index >= 0 ? projects[index].name : null,
          matchSource: source,
          // GitHub project settings (a selected repository becomes a project in the draft)
          selected: selected.has(String(link.analysisId)),
          displayName: link.displayName || null,
          defaultName: defaultProjectName(repositoryFullName),
          authorshipConfirmed: Boolean(link.authorshipConfirmedAt),
        };
      });

      res.set('Cache-Control', 'no-store');
      return res.status(200).json({
        links: rows,
        draftProjects: projects.map((p) => p.name),
        hasDraft,
        requestId: requestIdOf(req),
      });
    } catch (err) {
      return next(err);
    }
  }

  // PATCH /api/v2/github/links/:analysisId/details   body: { reportId, displayName?, authorshipConfirmed? }
  async function setLinkDetails(req, res, next) {
    const userId = req.user._id || req.user.id;
    const { analysisId } = req.params;
    const { displayName, authorshipConfirmed } = req.body;
    try {
      const link = await ReportProjectLink.findOne({ report: req.report._id, analysisId, user: userId });
      if (!link) {
        return sendError(req, res, 404, 'NOT_FOUND', 'Linked repository not found');
      }
      if (!link.control || link.control.verified !== true) {
        return sendError(req, res, 409, 'NOT_VERIFIED', 'Only repositories you own through GitHub Connect can be used as projects.');
      }

      if (displayName !== undefined) {
        if (displayName === null) {
          link.displayName = null;
        } else {
          const cleaned = sanitizeDisplayName(displayName);
          if (!cleaned) {
            return sendError(req, res, 400, 'INVALID_NAME', 'The project name cannot be empty.');
          }
          link.displayName = cleaned;
        }
      }
      if (authorshipConfirmed !== undefined) {
        link.authorshipConfirmedAt = authorshipConfirmed ? link.authorshipConfirmedAt || new Date() : null;
      }
      await link.save();

      return res.status(200).json({
        analysisId: String(link.analysisId),
        displayName: link.displayName || null,
        authorshipConfirmed: Boolean(link.authorshipConfirmedAt),
        requestId: requestIdOf(req),
      });
    } catch (err) {
      return next(err);
    }
  }

  // PUT /api/v2/github/links/:analysisId/project   body: { reportId, projectName | null }
  async function setLinkProject(req, res, next) {
    const userId = req.user._id || req.user.id;
    const { analysisId } = req.params;
    const { projectName } = req.body;
    try {
      const link = await ReportProjectLink.findOne({ report: req.report._id, analysisId, user: userId });
      if (!link) {
        return sendError(req, res, 404, 'NOT_FOUND', 'Linked repository not found');
      }

      let chosen = null;
      if (projectName !== null) {
        const { projects } = await latestDraftProjects(req.report._id, userId);
        const wanted = normalizeProjectKey(projectName);
        const match = projects.find((p) => normalizeProjectKey(p.name) === wanted);
        if (!match) {
          return sendError(req, res, 400, 'INVALID_PROJECT', 'Choose one of the projects in your resume draft.');
        }
        chosen = match.name;
      }

      link.projectName = chosen;
      await link.save();
      return res.status(200).json({ analysisId: String(link.analysisId), projectName: chosen, requestId: requestIdOf(req) });
    } catch (err) {
      return next(err);
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
      // Links created before ownership verification existed (pasted URLs) stay readable as unverified
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

  return {
    getConnection,
    startConnect,
    connectCallback,
    listRepos,
    disconnect,
    postAnalyzeRepo,
    getAnalysisById,
    listReportLinks,
    setLinkProject,
    setLinkDetails,
    startRanking,
    getReportRanking,
    putRankingSelection,
  };
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
  setRepoRankingService,
  disconnectGithubForUser,
  getConnection: defaultController.getConnection,
  startConnect: defaultController.startConnect,
  connectCallback: defaultController.connectCallback,
  listRepos: defaultController.listRepos,
  disconnect: defaultController.disconnect,
  postAnalyzeRepo: defaultController.postAnalyzeRepo,
  getAnalysisById: defaultController.getAnalysisById,
  listReportLinks: defaultController.listReportLinks,
  setLinkProject: defaultController.setLinkProject,
  setLinkDetails: defaultController.setLinkDetails,
  startRanking: defaultController.startRanking,
  getReportRanking: defaultController.getReportRanking,
  putRankingSelection: defaultController.putRankingSelection,
};
