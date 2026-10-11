const express = require('express');
const { z } = require('zod');
const { authUser } = require('../../middlewares/auth.middleware');
const { validate } = require('../middlewares/validate');
const { loadOwnedReport } = require('../middlewares/loadOwnedReport');
const { createRateLimiter } = require('../middlewares/rateLimits');
const { createDraft, getLatestDraft } = require('../controllers/draft.controller');

const router = express.Router();

const reportParamsSchema = z.object({
  reportId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid reportId format'),
});

const { getCfg } = require('../config/env');

const cfg = getCfg();

// Rate limiter for expensive draft generation (configurable per user)
const draftLimiter = createRateLimiter({
  windowMs: cfg.RATE_LIMIT_DRAFT_WINDOW_MS,
  max: cfg.RATE_LIMIT_DRAFT_MAX,
  message: 'Too many draft generation requests, please try again later',
});



// POST /api/v2/drafts/:reportId (standard spine: authUser -> rateLimit -> validate -> loadOwnedReport -> controller)
router.post(
  '/:reportId',
  authUser,
  draftLimiter,
  validate({ params: reportParamsSchema }),
  loadOwnedReport,
  createDraft
);

// GET /api/v2/drafts/:reportId (standard spine: authUser -> validate -> loadOwnedReport -> controller)
router.get(
  '/:reportId',
  authUser,
  validate({ params: reportParamsSchema }),
  loadOwnedReport,
  getLatestDraft
);

module.exports = router;
