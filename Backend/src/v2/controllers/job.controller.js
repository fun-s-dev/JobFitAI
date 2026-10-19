const defaultJobModel = require('../models/job');

function createJobController({ jobModel = defaultJobModel } = {}) {
  /**
   * GET /api/v2/jobs/:id
   * Fetches job state and progress. Returns 404 for non-existent or unowned jobs (IDOR defense).
   */
  async function getJobById(req, res, next) {
    const requestId = req.id || req.headers['x-request-id'] || 'unknown';
    try {
      const jobId = req.params.id;
      const userId = req.user ? (req.user._id || req.user.id) : null;

      const job = await jobModel.findById(jobId);
      if (!job || String(job.user) !== String(userId)) {
        return res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: 'Job not found',
            requestId,
          },
        });
      }

      return res.status(200).json({
        job,
        requestId,
      });
    } catch (err) {
      next(err);
    }
  }

  return {
    getJobById,
  };
}

const defaultController = createJobController();

module.exports = {
  createJobController,
  getJobById: defaultController.getJobById,
};
