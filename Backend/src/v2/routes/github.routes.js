const express = require('express');
const { authUser } = require('../../middlewares/auth.middleware');
const { validate } = require('../middlewares/validate');
const { loadOwnedReport } = require('../middlewares/loadOwnedReport');
const { createRateLimiter } = require('../middlewares/rateLimits');
const { getCfg } = require('../config/env');
const {
  analyzeRepoBodySchema,
  getAnalysisParamsSchema,
} = require('../schemas/github');
const {
  postAnalyzeRepo,
  getAnalysisById,
} = require('../controllers/github.controller');

const router = express.Router();
const cfg = getCfg();

const githubLimiter = createRateLimiter({
  windowMs: cfg.RATE_LIMIT_GITHUB_WINDOW_MS || 15 * 60 * 1000,
  max: cfg.RATE_LIMIT_GITHUB_MAX || 10,
  message: 'Too many GitHub analysis requests, please try again later',
});

// POST /api/v2/github/analyze
router.post(
  '/analyze',
  authUser,
  githubLimiter,
  validate({ body: analyzeRepoBodySchema }),
  loadOwnedReport,
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
