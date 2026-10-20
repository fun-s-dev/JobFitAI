const express = require('express');
const { errorHandler, notFoundHandler } = require('../middlewares/errorHandler');

const router = express.Router();

// GET /api/v2/health
router.get('/health', (req, res) => {
  const requestId = req.id || req.headers['x-request-id'] || null;
  res.status(200).json({
    status: 'ok',
    version: 'v2',
    requestId,
    timestamp: new Date().toISOString(),
  });
});

// GET /api/v2/demo/resume (serves scratch/my-resume.pdf for browser verification)
const path = require('path');
const fs = require('fs');
router.get('/demo/resume', (req, res) => {
  const resumePath = path.resolve(__dirname, '../../../scratch/my-resume.pdf');
  if (fs.existsSync(resumePath)) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="my-resume.pdf"');
    return fs.createReadStream(resumePath).pipe(res);
  }
  res.status(404).json({ error: 'Demo resume not found' });
});

// Drafts endpoints
const draftRouter = require('./draft.routes');
router.use('/drafts', draftRouter);

// Verification endpoints
const verificationRouter = require('./verification.routes');
router.use('/verification', verificationRouter);

// Jobs endpoints
const jobRouter = require('./job.routes');
router.use('/jobs', jobRouter);

// GitHub analysis endpoints
const githubRouter = require('./github.routes');
router.use('/github', githubRouter);

// v2 Not Found handler for unknown /api/v2 routes

router.use(notFoundHandler);

// v2 Router-scoped Error Handler
router.use(errorHandler);

module.exports = router;
