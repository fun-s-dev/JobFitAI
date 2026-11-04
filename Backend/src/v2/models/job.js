const mongoose = require('mongoose');

const progressSubSchema = new mongoose.Schema(
  {
    done: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
  },
  { _id: false }
);

const errorSubSchema = new mongoose.Schema(
  {
    code: { type: String, default: null },
    message: { type: String, default: null },
  },
  { _id: false }
);

const jobSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    report: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'InterviewReport',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['verification', 'github_analysis', 'repo_ranking'],
      default: 'verification',
      required: true,
    },
    repoUrl: {
      type: String,
      default: null,
    },
    // Repository control proof captured when a github_analysis job is created (see githubConnect flow)
    repoControl: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    githubAnalysisIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'GithubAnalysis',
      },
    ],
    status: {
      type: String,
      enum: ['queued', 'running', 'done', 'failed'],
      default: 'queued',
      required: true,
      index: true,
    },
    progress: {
      type: progressSubSchema,
      default: () => ({ done: 0, total: 0 }),
    },
    resultRef: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    error: {
      type: errorSubSchema,
      default: null,
    },
    startedAt: {
      type: Date,
      default: null,
    },
    finishedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Retention: finished jobs (done/failed) are removed automatically after JOB_RETENTION_DAYS (default 30)
const jobRetentionDays = parseInt(process.env.JOB_RETENTION_DAYS, 10) || 30;
jobSchema.index(
  { finishedAt: 1 },
  {
    expireAfterSeconds: jobRetentionDays * 86400,
    partialFilterExpression: { status: { $in: ['done', 'failed'] } },
  }
);
// Per-user daily GitHub analysis cap counts jobs by user + type + creation time
jobSchema.index({ user: 1, type: 1, createdAt: 1 });

// Partial unique index for active jobs to ensure idempotency on double-clicks
jobSchema.index(
  { report: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['queued', 'running'] } },
  }
);

const Job = mongoose.models.Job || mongoose.model('Job', jobSchema);

module.exports = Job;
