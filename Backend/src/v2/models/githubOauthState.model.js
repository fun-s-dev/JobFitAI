const mongoose = require('mongoose');

/**
 * Pending GitHub authorization attempts (CSRF `state` + PKCE verifier).
 * - The state is stored only as a SHA-256 hash.
 * - The PKCE code verifier is stored encrypted.
 * - Single use: consumed (deleted) atomically by the callback.
 * - Bound to the user who started the flow.
 * - Expires after 10 minutes (TTL index).
 */
const STATE_TTL_SECONDS = 10 * 60;

const githubOauthStateSchema = new mongoose.Schema({
  stateHash: { type: String, required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  codeVerifierEnc: { type: String, required: true },
  returnTo: { type: String, default: '/' },
  createdAt: { type: Date, default: Date.now },
});

githubOauthStateSchema.index({ stateHash: 1 }, { unique: true });
githubOauthStateSchema.index({ createdAt: 1 }, { expireAfterSeconds: STATE_TTL_SECONDS });
githubOauthStateSchema.index({ user: 1 });

const GithubOauthState =
  mongoose.models.GithubOauthState || mongoose.model('GithubOauthState', githubOauthStateSchema);

module.exports = GithubOauthState;
module.exports.STATE_TTL_SECONDS = STATE_TTL_SECONDS;
