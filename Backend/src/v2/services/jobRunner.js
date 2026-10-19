const defaultJobModel = require('../models/job');
const { QuotaExhaustedError } = require('../errors/LlmErrors');

/**
 * Runs a single verification job asynchronously in-process.
 * Updates status: queued -> running -> done | failed.
 * Periodically updates claim progress via onProgress callback.
 *
 * @param {object} params
 * @param {string} params.jobId
 * @param {object} params.verificationService
 * @param {object} [params.jobModel=defaultJobModel]
 */
async function runVerificationJob({ jobId, verificationService, jobModel = defaultJobModel }) {
  const job = await jobModel.findById(jobId);
  if (!job) {
    return;
  }

  // If already processed or interrupted, do not proceed
  if (job.status !== 'queued') {
    return;
  }

  job.status = 'running';
  job.startedAt = new Date();
  await job.save();

  try {
    const result = await verificationService.verifyReport({
      reportId: String(job.report),
      userId: String(job.user),
      githubAnalysisIds: job.githubAnalysisIds || [],
      onProgress: async ({ done, total }) => {
        try {
          await jobModel.updateOne(
            { _id: job._id },
            { $set: { 'progress.done': done, 'progress.total': total } }
          );
        } catch {
          // Swallow intermediate progress persistence errors so the main job keeps going
        }
      },
    });

    job.status = 'done';
    job.resultRef = result.run?._id || result.run;
    job.finishedAt = new Date();
    await jobModel.updateOne(
      { _id: job._id },
      {
        $set: {
          status: 'done',
          resultRef: job.resultRef,
          finishedAt: job.finishedAt,
        },
      }
    );
  } catch (err) {
    const isQuota =
      err instanceof QuotaExhaustedError ||
      err.name === 'QuotaExhaustedError' ||
      err.code === 'LLM_QUOTA_EXHAUSTED' ||
      (err.message && err.message.toLowerCase().includes('quota'));

    const errorCode = isQuota ? 'QUOTA_EXHAUSTED' : err.code || 'JOB_FAILED';
    const errorMessage = isQuota
      ? 'Gemini daily free-tier quota exhausted. Resets at midnight Pacific. Please try again tomorrow.'
      : err.message || 'Verification job failed';

    job.status = 'failed';
    job.error = {
      code: errorCode,
      message: errorMessage,
    };
    job.finishedAt = new Date();
    await jobModel.updateOne(
      { _id: job._id },
      {
        $set: {
          status: 'failed',
          error: job.error,
          finishedAt: job.finishedAt,
        },
      }
    );
  }
}

/**
 * Idempotently starts or returns an existing active verification job.
 * Protects against double-click via DB query + partial unique index catch.
 * Kicks off work in-process via setImmediate after returning.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.reportId
 * @param {object} params.verificationService
 * @param {object} [params.jobModel=defaultJobModel]
 * @returns {Promise<{ job: object, isNew: boolean }>}
 */
async function startVerificationJob({
  userId,
  reportId,
  githubAnalysisIds = [],
  verificationService,
  jobModel = defaultJobModel,
}) {
  // 1. Check for an already active (queued or running) job for this report
  const existingJob = await jobModel.findOne({
    report: reportId,
    type: 'verification',
    status: { $in: ['queued', 'running'] },
  });

  if (existingJob) {
    return { job: existingJob, isNew: false };
  }

  // 2. Create a new queued job
  let newJob;
  try {
    newJob = await jobModel.create({
      user: userId,
      report: reportId,
      type: 'verification',
      githubAnalysisIds,
      status: 'queued',
      progress: { done: 0, total: 0 },
    });
  } catch (err) {
    // If double-click created a race condition, catch Mongo 11000 duplicate key error
    if (err.code === 11000) {
      const raceJob = await jobModel.findOne({
        report: reportId,
        type: 'verification',
        status: { $in: ['queued', 'running'] },
      });
      if (raceJob) {
        return { job: raceJob, isNew: false };
      }
    }
    throw err;
  }

  // 3. Kick off execution asynchronously in-process (after HTTP response)
  setImmediate(async () => {
    try {
      await runVerificationJob({
        jobId: newJob._id,
        verificationService,
        jobModel,
      });
    } catch (bgErr) {
      console.error('Unhandled background verification job error:', bgErr);
    }
  });

  return { job: newJob, isNew: true };
}

/**
 * Runs a single GitHub analysis job asynchronously in-process.
 */
async function runGitHubAnalysisJob({
  jobId,
  githubEvidenceService,
  jobModel = defaultJobModel,
}) {
  const service = githubEvidenceService || require('./githubEvidence.service').githubEvidenceService;
  const job = await jobModel.findById(jobId);
  if (!job || job.status !== 'queued') {
    return;
  }

  job.status = 'running';
  job.startedAt = new Date();
  await job.save();

  try {
    const result = await service.analyzeRepository({
      repoUrl: job.repoUrl,
      reportId: String(job.report),
      userId: String(job.user),
      onProgress: async ({ done, total }) => {
        try {
          await jobModel.updateOne(
            { _id: job._id },
            { $set: { 'progress.done': done, 'progress.total': total } }
          );
        } catch {}
      },
    });

    job.status = 'done';
    job.resultRef = result.analysis._id;
    job.finishedAt = new Date();
    await jobModel.updateOne(
      { _id: job._id },
      {
        $set: {
          status: 'done',
          resultRef: job.resultRef,
          finishedAt: job.finishedAt,
        },
      }
    );
  } catch (err) {
    job.status = 'failed';
    job.error = {
      code: err.name || 'GITHUB_ANALYSIS_FAILED',
      message: err.message || 'GitHub analysis job failed',
    };
    job.finishedAt = new Date();
    await jobModel.updateOne(
      { _id: job._id },
      {
        $set: {
          status: 'failed',
          error: job.error,
          finishedAt: job.finishedAt,
        },
      }
    );
  }
}

/**
 * Starts a GitHub analysis job idempotently.
 */
async function startGitHubAnalysisJob({
  userId,
  reportId,
  repoUrl,
  githubEvidenceService,
  jobModel = defaultJobModel,
}) {
  const existingJob = await jobModel.findOne({
    report: reportId,
    type: 'github_analysis',
    status: { $in: ['queued', 'running'] },
  });

  if (existingJob) {
    return { job: existingJob, isNew: false };
  }

  let newJob;
  try {
    newJob = await jobModel.create({
      user: userId,
      report: reportId,
      type: 'github_analysis',
      repoUrl,
      status: 'queued',
      progress: { done: 0, total: 0 },
    });
  } catch (err) {
    if (err.code === 11000) {
      const raceJob = await jobModel.findOne({
        report: reportId,
        type: 'github_analysis',
        status: { $in: ['queued', 'running'] },
      });
      if (raceJob) {
        return { job: raceJob, isNew: false };
      }
    }
    throw err;
  }

  setImmediate(async () => {
    try {
      await runGitHubAnalysisJob({
        jobId: newJob._id,
        githubEvidenceService,
        jobModel,
      });
    } catch (bgErr) {
      console.error('Unhandled background GitHub analysis job error:', bgErr);
    }
  });

  return { job: newJob, isNew: true };
}

/**
 * Server boot cleanup: marks any jobs left in 'running' state as failed ('interrupted').
 * Called during server startup after database connection is established.
 *
 * @param {object} [options]
 * @param {object} [options.jobModel=defaultJobModel]
 * @returns {Promise<object>} MongoDB update result
 */
async function cleanupInterruptedJobs({ jobModel = defaultJobModel } = {}) {
  const result = await jobModel.updateMany(
    { status: 'running' },
    {
      $set: {
        status: 'failed',
        error: {
          code: 'INTERRUPTED',
          message: 'Job interrupted by server restart',
        },
        finishedAt: new Date(),
      },
    }
  );
  return result;
}

module.exports = {
  runVerificationJob,
  startVerificationJob,
  runGitHubAnalysisJob,
  startGitHubAnalysisJob,
  cleanupInterruptedJobs,
};
