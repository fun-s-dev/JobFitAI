const mongoose = require('mongoose');
const InterviewReport = require('../../models/interviewReport.model');

/**
 * Middleware ensuring the requested report exists AND belongs to the authenticated user.
 * Returns 404 (not 403) on miss or invalid ID so IDs cannot be probed (IDOR defense).
 */
async function loadOwnedReport(req, res, next) {
  const requestId = req.id || req.headers['x-request-id'] || 'unknown';
  const reportId = req.params.reportId || req.params.id || (req.body && req.body.reportId);

  if (!reportId || !mongoose.isValidObjectId(reportId)) {
    return res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'Report not found',
        requestId,
      },
    });
  }

  const userId = req.user ? (req.user._id || req.user.id) : null;
  if (!userId) {
    return res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
        requestId,
      },
    });
  }

  try {
    const report = await InterviewReport.findOne({ _id: reportId, user: userId });
    if (!report) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Report not found',
          requestId,
        },
      });
    }

    req.report = report;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = {
  loadOwnedReport,
};
