const express = require('express');
const { authUser } = require('../../middlewares/auth.middleware');
const { validate } = require('../middlewares/validate');
const { loadOwnedReport } = require('../middlewares/loadOwnedReport');
const { createRateLimiter } = require('../middlewares/rateLimits');
const { guardLlmGenerationBudget, guardUserDailyGithubAnalyses } = require('../middlewares/budgetGuard');
const { getCfg } = require('../config/env');
const {
  analyzeRepoBodySchema,
  getAnalysisParamsSchema,
  connectStartBodySchema,
} = require('../schemas/github');
const {
  postAnalyzeRepo,
  getAnalysisById,
  getConnection,
  startConnect,
  connectCallback,
  listRepos,
  disconnect,
} = require('../controllers/github.controller');

const router = express.Router();
const cfg = getCfg();

const githubLimiter = createRateLimiter({
  windowMs: cfg.RATE_LIMIT_GITHUB_WINDOW_MS || 15 * 60 * 1000,
  max: cfg.RATE_LIMIT_GITHUB_MAX || 10,
  message: 'Too many GitHub analysis requests, please try again later',
});

// Connect / repository listing / disconnect all touch GitHub or secrets: limit them per user
const connectLimiter = createRateLimiter({
  windowMs: cfg.RATE_LIMIT_GITHUB_CONNECT_WINDOW_MS,
  max: cfg.RATE_LIMIT_GITHUB_CONNECT_MAX,
  message: 'Too many GitHub connection requests, please try again later',
});

/**
 * The OAuth callback is a top-level browser navigation. If the session cookie is missing or invalid
 * the user is sent to the login page instead of seeing a raw JSON 401. The `state` parameter is
 * additionally bound to the logged-in user inside the service.
 */
function authUserOrRedirectToLogin(req, res, next) {
  let base = 'http://localhost:5173';
  try {
    base = (getCfg().FRONTEND_URL || base).replace(/\/+$/, '');
  } catch {
    // keep default
  }
  const redirectingRes = {
    status() {
      return redirectingRes;
    },
    json() {
      res.set('Cache-Control', 'no-store');
      return res.redirect(302, `${base}/login`);
    },
  };
  return authUser(req, redirectingRes, next);
}

// --- GitHub Connect (GitHub App user authorization) ---------------------------------------------

// GET /api/v2/github/connection  -> { connection: { configured, connected, login, ... } } (never tokens)
router.get('/connection', authUser, getConnection);

// POST /api/v2/github/connect/start  -> { authorizeUrl }  (POST: a cross-site link cannot start a flow)
router.post(
  '/connect/start',
  authUser,
  connectLimiter,
  validate({ body: connectStartBodySchema }),
  startConnect
);

// GET /api/v2/github/connect/callback  (registered as the GitHub App "Callback URL")
router.get('/connect/callback', connectLimiter, authUserOrRedirectToLogin, connectCallback);

// GET /api/v2/github/repos  -> owned PUBLIC repositories of the connected account, classified
router.get('/repos', authUser, connectLimiter, listRepos);

// DELETE /api/v2/github/connection  -> revoke at GitHub (best effort) and delete stored tokens
router.delete('/connection', authUser, connectLimiter, disconnect);

// --- Repository analysis -------------------------------------------------------------------------

// POST /api/v2/github/analyze
router.post(
  '/analyze',
  authUser,
  githubLimiter,
  validate({ body: analyzeRepoBodySchema }),
  loadOwnedReport,
  guardUserDailyGithubAnalyses,
  guardLlmGenerationBudget,
  postAnalyzeRepo
);

// GET /api/v2/github/analysis/:analysisId
router.get(
  '/analysis/:analysisId',
  authUser,
  validate({ params: getAnalysisParamsSchema }),
  getAnalysisById
);

module.exports = router;
