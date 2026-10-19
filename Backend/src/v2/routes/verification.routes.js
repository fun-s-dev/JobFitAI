const express = require('express');
const { authUser } = require('../../middlewares/auth.middleware');
const { validate } = require('../middlewares/validate');
const { loadOwnedReport } = require('../middlewares/loadOwnedReport');
const { createRateLimiter } = require('../middlewares/rateLimits');
const { getCfg } = require('../config/env');
const {
  reportParamsSchema,
  verifyQuerySchema,
  verifyBodySchema,
  claimParamsSchema,
  claimOverrideBodySchema,
} = require('../schemas/verification');
const {
  postVerifyReport,
  getReportVerification,
  patchClaimOverride,
  getClaimById,
} = require('../controllers/verification.controller');

const router = express.Router();
const cfg = getCfg();

// Rate limiter for verification runs
const verifyLimiter = createRateLimiter({
  windowMs: cfg.RATE_LIMIT_VERIFY_WINDOW_MS || 15 * 60 * 1000,
  max: cfg.RATE_LIMIT_VERIFY_MAX || 10,
  message: 'Too many verification requests, please try again later',
});

// POST /api/v2/verification/:reportId
router.post(
  '/:reportId',
  authUser,
  verifyLimiter,
  validate({ params: reportParamsSchema, body: verifyBodySchema, query: verifyQuerySchema }),
  loadOwnedReport,
  postVerifyReport
);

// GET /api/v2/verification/:reportId (?runId=)
router.get(
  '/:reportId',
  authUser,
  validate({ params: reportParamsSchema, query: verifyQuerySchema }),
  loadOwnedReport,
  getReportVerification
);

// GET /api/v2/verification/claim/:claimId (and /claims/:claimId)
router.get(
  '/claim/:claimId',
  authUser,
  validate({ params: claimParamsSchema }),
  getClaimById
);
router.get(
  '/claims/:claimId',
  authUser,
  validate({ params: claimParamsSchema }),
  getClaimById
);

// PATCH /api/v2/verification/claim/:claimId (and /claims/:claimId)
router.patch(
  '/claim/:claimId',
  authUser,
  validate({ params: claimParamsSchema, body: claimOverrideBodySchema }),
  patchClaimOverride
);
router.patch(
  '/claims/:claimId',
  authUser,
  validate({ params: claimParamsSchema, body: claimOverrideBodySchema }),
  patchClaimOverride
);

module.exports = router;
