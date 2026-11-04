const mongoose = require('mongoose');

const bulletSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    text: { type: String, required: true },
    // Repository passages the bullet was written from (GitHub projects only)
    sources: [{ type: String }],
  },
  { _id: false }
);

const experienceEntrySchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    company: { type: String, required: true },
    role: { type: String, required: true },
    dates: { type: String, default: '' },
    bullets: [bulletSchema],
  },
  { _id: false }
);

const projectEntrySchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    bullets: [bulletSchema],
    source: { type: String, enum: ['resume', 'github'], default: undefined },
    analysisId: { type: mongoose.Schema.Types.ObjectId, ref: 'GithubAnalysis', default: undefined },
    repoFullName: { type: String, default: undefined },
    tech: [{ type: String }],
  },
  { _id: false }
);

const educationEntrySchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    school: { type: String, required: true },
    degree: { type: String, required: true },
    dates: { type: String, default: '' },
  },
  { _id: false }
);

const draftContentSchema = new mongoose.Schema(
  {
    name: { type: String, default: '' },
    contact: [{ type: String }],
    summary: { type: String, default: '' },
    experience: [experienceEntrySchema],
    projects: [projectEntrySchema],
    skills: [{ type: String }],
    education: [educationEntrySchema],
  },
  { _id: false }
);

const resumeDraftSchema = new mongoose.Schema(
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
      type: draftContentSchema,
      required: true,
    },
    version: {
      type: Number,
      default: 1,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for fast lookup of the latest draft for a report
resumeDraftSchema.index({ report: 1, createdAt: -1 });

const ResumeDraft = mongoose.model('ResumeDraft', resumeDraftSchema);

module.exports = ResumeDraft;
