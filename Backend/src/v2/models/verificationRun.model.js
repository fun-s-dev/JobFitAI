const mongoose = require('mongoose');

const verificationRunSchema = new mongoose.Schema(
  {
    report: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'InterviewReport',
      required: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    draft: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ResumeDraft',
      required: true,
    },
    githubAnalyses: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'GithubAnalysis',
      },
    ],
    config: {
      weights: {
        type: mongoose.Schema.Types.Mixed,
        required: true,
      },
      thresholds: {
        type: mongoose.Schema.Types.Mixed,
        required: true,
      },
      similarityScale: {
        lo: { type: Number, default: 0.5 },
        hi: { type: Number, default: 0.9 },
      },
      generationModel: { type: String, default: '' },
      embeddingModel: { type: String, default: '' },
      embeddingDims: { type: Number, default: 768 },
    },
    counts: {
      verified: { type: Number, default: 0 },
      needsReview: { type: Number, default: 0 },
      rejected: { type: Number, default: 0 },
    },
    jobId: {
      type: String,
      default: null,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: false,
  }
);

// Compound index for instant retrieval of the latest run for a report
verificationRunSchema.index({ report: 1, createdAt: -1 });

const VerificationRun =
  mongoose.models.VerificationRun ||
  mongoose.model('VerificationRun', verificationRunSchema);

module.exports = VerificationRun;
