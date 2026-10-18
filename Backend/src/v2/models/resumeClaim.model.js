const mongoose = require('mongoose');

const evidenceItemSubSchema = new mongoose.Schema(
  {
    chunkId: { type: String, default: '' },
    source: { type: String, default: 'resume' },
    section: { type: String, default: '' },
    text: { type: String, default: '' },
    start: { type: Number, default: 0 },
    end: { type: Number, default: 0 },
    cosine: { type: Number, default: 0 },
    similarityScore: { type: Number, default: 0 },
  },
  { _id: false }
);

const entailmentSubSchema = new mongoose.Schema(
  {
    verdict: {
      type: String,
      enum: ['yes', 'partial', 'no'],
      required: true,
    },
    score: { type: Number, required: true },
    evidenceQuote: { type: String, default: '' },
    missingElements: [{ type: String }],
    quoteUngrounded: { type: Boolean, default: false },
  },
  { _id: false }
);

const projectEvidenceSubSchema = new mongoose.Schema(
  {
    score: { type: Number, default: null },
    evidenceItemIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'EvidenceItem' }],
    contradictions: [{ type: String }],
  },
  { _id: false }
);

const userOverrideSubSchema = new mongoose.Schema(
  {
    decision: {
      type: String,
      enum: ['approved', 'rejected'],
      required: true,
    },
    at: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const provenanceSubSchema = new mongoose.Schema(
  {
    generationModel: { type: String, default: '' },
    embeddingModel: { type: String, default: '' },
    weights: { type: mongoose.Schema.Types.Mixed, default: {} },
    thresholds: { type: mongoose.Schema.Types.Mixed, default: {} },
    verifiedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const resumeClaimSchema = new mongoose.Schema(
  {
    run: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'VerificationRun',
      required: true,
    },
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
    bulletId: {
      type: String,
      required: true,
    },
    claimText: {
      type: String,
      required: true,
    },
    claimType: {
      type: String,
      enum: ['technology', 'responsibility', 'metric', 'leadership', 'outcome', 'other'],
      default: 'other',
    },
    skills: [{ type: String }],
    numbers: [{ type: String }],

    resumeEvidence: [evidenceItemSubSchema],
    entailment: {
      type: entailmentSubSchema,
      required: true,
    },
    projectEvidence: {
      type: projectEvidenceSubSchema,
      default: () => ({ score: null, evidenceItemIds: [], contradictions: [] }),
    },
    caps: [{ type: String }],

    confidenceScore: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      enum: ['verified', 'needs_review', 'rejected'],
      required: true,
      immutable: true, // Write-once automated status
    },
    userOverride: {
      type: userOverrideSubSchema,
      default: null,
    },
    provenance: {
      type: provenanceSubSchema,
      required: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Compound index for status filtering and retrieval per report
resumeClaimSchema.index({ report: 1, status: 1 });
// Index by run
resumeClaimSchema.index({ run: 1 });

// Defensive hook: prevent query-level updates (updateOne, findOneAndUpdate, updateMany) from altering automated status
resumeClaimSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], function () {
  const update = this.getUpdate();
  if (update) {
    if (update.status !== undefined || (update.$set && update.$set.status !== undefined)) {
      throw new Error('Automated status is immutable and cannot be updated');
    }
  }
});

// Virtual effectiveStatus helper
resumeClaimSchema.virtual('effectiveStatus').get(function () {
  return this.userOverride?.decision ?? this.status;
});

const ResumeClaim =
  mongoose.models.ResumeClaim || mongoose.model('ResumeClaim', resumeClaimSchema);

module.exports = ResumeClaim;
