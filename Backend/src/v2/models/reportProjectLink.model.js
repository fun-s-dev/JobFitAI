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
    // The draft project this repository belongs to, chosen by the user. When null the repository
    // is matched to a draft project by name (see core/projectMatching.js).
    projectName: { type: String, default: null, maxlength: 200 },
    // Name shown on the resume for a GitHub project (null = the default derived from the repository name)
    displayName: { type: String, default: null, maxlength: 100 },
    // When the user confirmed "I built this project". Owning a repository does not show authorship, so a
    // GitHub project is only exported after this confirmation.
    authorshipConfirmedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Compound unique index ensuring a report links to a given analysis at most once
reportProjectLinkSchema.index({ report: 1, analysisId: 1 }, { unique: true });

const ReportProjectLink =
  mongoose.models.ReportProjectLink ||
  mongoose.model('ReportProjectLink', reportProjectLinkSchema);

module.exports = ReportProjectLink;
