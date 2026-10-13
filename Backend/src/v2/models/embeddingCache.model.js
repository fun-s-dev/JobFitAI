const mongoose = require('mongoose');

const ttlDays = parseInt(process.env.EMBEDDING_CACHE_TTL_DAYS, 10) || 90;
const ttlSeconds = ttlDays * 86400;

const embeddingCacheSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    vector: {
      type: Buffer,
      required: true,
    },
    dims: {
      type: Number,
      required: true,
    },
    model: {
      type: String,
      required: true,
    },
    taskType: {
      type: String,
      required: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: false,
    versionKey: false,
  }
);

// TTL index on createdAt so cached embedding vectors do not live indefinitely
embeddingCacheSchema.index({ createdAt: 1 }, { expireAfterSeconds: ttlSeconds });

const EmbeddingCache = mongoose.models.EmbeddingCache || mongoose.model('EmbeddingCache', embeddingCacheSchema);

module.exports = EmbeddingCache;
