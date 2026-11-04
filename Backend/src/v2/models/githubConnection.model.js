const mongoose = require('mongoose');

/**
 * Links one JobFitAI user to one GitHub account through a GitHub App user authorization.
 *
 * Tokens are stored ENCRYPTED (AES-256-GCM, see core/tokenCrypto.js), are excluded from queries by
 * default (`select: false`) and are removed from toJSON/toObject output, so they cannot reach an API
 * response by accident. They never leave the backend.
 */
const githubConnectionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Numeric GitHub account id (stable; logins can be renamed)
    githubUserId: { type: Number, required: true },
    login: { type: String, required: true },
    avatarUrl: { type: String, default: null },

    accessTokenEnc: { type: String, default: null, select: false },
    refreshTokenEnc: { type: String, default: null, select: false },
    accessTokenExpiresAt: { type: Date, default: null },
    refreshTokenExpiresAt: { type: Date, default: null },

    status: { type: String, enum: ['active', 'needs_reconnect'], default: 'active' },
    statusReason: {
      type: String,
      enum: ['refresh_failed', 'unauthorized', 'expired'],
      default: null,
    },

    connectedAt: { type: Date, default: Date.now },
    lastRefreshedAt: { type: Date, default: null },
    // Cross-process lock: refresh tokens are single use, so only one refresh may run at a time
    refreshLockUntil: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: { transform: stripSecrets },
    toObject: { transform: stripSecrets },
  }
);

function stripSecrets(_doc, ret) {
  delete ret.accessTokenEnc;
  delete ret.refreshTokenEnc;
  delete ret.refreshLockUntil;
  return ret;
}

// One GitHub connection per JobFitAI user, and one JobFitAI user per GitHub account
githubConnectionSchema.index({ user: 1 }, { unique: true });
githubConnectionSchema.index({ githubUserId: 1 }, { unique: true });

const GithubConnection =
  mongoose.models.GithubConnection || mongoose.model('GithubConnection', githubConnectionSchema);

module.exports = GithubConnection;
