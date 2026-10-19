const mongoose = require('mongoose');

const reportProjectLinkSchema = new mongoose.Schema(
  {
    report: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'interviewReport',
      required: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    analysisId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'GithubAnalysis',
      required: true,
      index: true,
    },
    repoUrl: {
      type: String,
      required: true,
    },
    linkedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// Compound unique index ensuring a report links to a given analysis at most once
reportProjectLinkSchema.index({ report: 1, analysisId: 1 }, { unique: true });

const ReportProjectLink =
  mongoose.models.ReportProjectLink ||
  mongoose.model('ReportProjectLink', reportProjectLinkSchema);

module.exports = ReportProjectLink;
