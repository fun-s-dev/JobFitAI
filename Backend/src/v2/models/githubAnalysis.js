const mongoose = require('mongoose');

const evidenceItemSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['dependency', 'readme', 'source_file', 'test', 'project_structure', 'metadata'],
      required: true,
    },
    skill: { type: String, required: true },
    claimSupport: { type: String, required: true },
    sourcePath: { type: String, required: true },
    lineStart: { type: Number, default: null },
    lineEnd: { type: Number, default: null },
    strength: { type: Number, min: 0, max: 1, required: true },
    contradiction: { type: Boolean, default: false },
  },
  { _id: true }
);

const dependencySchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    version: { type: String, default: '*' },
    ecosystem: { type: String, required: true },
    skills: [{ type: String }],
  },
  { _id: false }
);

const githubAnalysisSchema = new mongoose.Schema(
  {
    repositoryUrl: { type: String, required: true },
    repositoryFullName: { type: String, required: true }, // e.g. "owner/repo"
    commitSha: { type: String, required: true },
    defaultBranch: { type: String, default: 'main' },
    languages: { type: mongoose.Schema.Types.Mixed, default: {} },
    dependencies: [dependencySchema],
    evidenceItems: [evidenceItemSchema],
    analysisStatus: {
      type: String,
      enum: ['pending', 'complete', 'failed', 'stale'],
      default: 'pending',
    },
    etag: { type: String, default: null },
    analyzedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Cache key index: compound unique on { repositoryFullName, commitSha }
githubAnalysisSchema.index({ repositoryFullName: 1, commitSha: 1 }, { unique: true });

const GithubAnalysis = mongoose.models.GithubAnalysis || mongoose.model('GithubAnalysis', githubAnalysisSchema);

module.exports = GithubAnalysis;
