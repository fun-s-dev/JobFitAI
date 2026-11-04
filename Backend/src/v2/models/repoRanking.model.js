const mongoose = require('mongoose');

const requirementSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    importance: { type: String, enum: ['must', 'nice'], default: 'nice' },
    keywords: [{ type: String }],
  },
  { _id: false }
);

const matchedSchema = new mongoose.Schema(
  {
    requirement: { type: String, required: true },
    importance: { type: String, enum: ['must', 'nice'], default: 'nice' },
    cosine: { type: Number, default: 0 },
    source: { type: String, default: '' },
    snippet: { type: String, default: '' },
  },
  { _id: false }
);

const rankedRepoSchema = new mongoose.Schema(
  {
    repoId: { type: Number, required: true },
    fullName: { type: String, required: true },
    htmlUrl: { type: String, default: '' },
    description: { type: String, default: null },
    language: { type: String, default: null },
    pushedAt: { type: Date, default: null },
    analysisId: { type: mongoose.Schema.Types.ObjectId, ref: 'GithubAnalysis', default: null },
    status: { type: String, enum: ['ranked', 'skipped_no_readme', 'skipped_error'], required: true },
    // Human-readable explanation shown to the user for skipped repositories
    skipReason: { type: String, default: null },
    rank: { type: Number, default: null },
    score: { type: Number, default: null },
    level: { type: String, enum: ['strong', 'partial', 'weak', null], default: null },
    semanticScore: { type: Number, default: null },
    keywordScore: { type: Number, default: null },
    matched: [matchedSchema],
    unmatchedRequirements: { type: Number, default: 0 },
  },
  { _id: false }
);

/**
 * The ranking of a user's repositories against the job description of one report.
 * One document per report: running the ranking again replaces it.
 */
const repoRankingSchema = new mongoose.Schema(
  {
    report: { type: mongoose.Schema.Types.ObjectId, ref: 'InterviewReport', required: true, unique: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    jobDescriptionHash: { type: String, required: true },
    requirements: [requirementSchema],
    repos: [rankedRepoSchema],
    // Repositories the user chose to use (at most the configured top N). Defaults to the top ranked.
    selectedRepoIds: [{ type: Number }],
    selectionConfirmedAt: { type: Date, default: null },
    rankedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const RepoRanking = mongoose.models.RepoRanking || mongoose.model('RepoRanking', repoRankingSchema);

module.exports = RepoRanking;
