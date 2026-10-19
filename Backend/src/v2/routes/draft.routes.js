const express = require('express');
const { z } = require('zod');
const { authUser } = require('../../middlewares/auth.middleware');
const { validate } = require('../middlewares/validate');
const { loadOwnedReport } = require('../middlewares/loadOwnedReport');
const { createRateLimiter } = require('../middlewares/rateLimits');
const {
  createDraft,
  getLatestDraft,
  getPrintDraft,
  renderDraftPdf,
  getGroundedDraftInfo,
} = require('../controllers/draft.controller');

const router = express.Router();

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

const reportParamsSchema = z.object({
  reportId: z.string().regex(objectIdRegex, 'Invalid reportId format'),
});

const printQuerySchema = z.object({
  runId: z.string().regex(objectIdRegex, 'Invalid runId format').optional(),
});

const pdfBodySchema = z
  .object({
    runId: z.string().regex(objectIdRegex, 'Invalid runId format').optional(),
  })
  .optional();

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

// GET /api/v2/drafts/:reportId/print?runId= (grounded ATS HTML with strict CSP)
router.get(
  '/:reportId/print',
  authUser,
  validate({ params: reportParamsSchema, query: printQuerySchema }),
  loadOwnedReport,
  getPrintDraft
);

// POST /api/v2/drafts/:reportId/pdf (server-side grounded PDF export via Puppeteer)
router.post(
  '/:reportId/pdf',
  authUser,
  validate({ params: reportParamsSchema, body: pdfBodySchema, query: printQuerySchema }),
  loadOwnedReport,
  renderDraftPdf
);

// GET /api/v2/drafts/:reportId/grounded?runId= (grounded breakdown metadata for UI)
router.get(
  '/:reportId/grounded',
  authUser,
  validate({ params: reportParamsSchema, query: printQuerySchema }),
  loadOwnedReport,
  getGroundedDraftInfo
);

module.exports = router;
