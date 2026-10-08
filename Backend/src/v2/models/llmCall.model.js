const mongoose = require('mongoose');

const llmCallSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    runId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    purpose: {
      type: String,
      required: true,
      index: true,
    },
    model: {
      type: String,
      required: true,
    },
    attempt: {
      type: Number,
      required: true,
      default: 1,
    },
    ok: {
      type: Boolean,
      required: true,
    },
    ms: {
      type: Number,
      required: true,
    },
    tokensIn: {
      type: Number,
      default: 0,
    },
    tokensOut: {
      type: Number,
      default: 0,
    },
    costEstimate: {
      type: Number,
      default: 0,
    },
    error: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

llmCallSchema.index({ runId: 1 });
llmCallSchema.index({ createdAt: 1 });

const LlmCall = mongoose.models.LlmCall || mongoose.model('LlmCall', llmCallSchema);

module.exports = LlmCall;
