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
    // Repository CONTROL evidence. Links created before this field existed have no `control`
    // and are treated as unverified. Control is never evidence of code AUTHORSHIP.
    control: {
      verified: { type: Boolean, default: false },
      method: {
        type: String,
        enum: ['github_app_identity', 'pasted_public_url'],
        default: 'pasted_public_url',
      },
      githubUserId: { type: Number, default: null },
      githubLogin: { type: String, default: null },
      repoId: { type: Number, default: null },
      verifiedAt: { type: Date, default: null },
    },
    authorship: { type: String, enum: ['not_assessed'], default: 'not_assessed' },
  },
  { timestamps: true }
);

// Compound unique index ensuring a report links to a given analysis at most once
reportProjectLinkSchema.index({ report: 1, analysisId: 1 }, { unique: true });

const ReportProjectLink =
  mongoose.models.ReportProjectLink ||
  mongoose.model('ReportProjectLink', reportProjectLinkSchema);

module.exports = ReportProjectLink;
