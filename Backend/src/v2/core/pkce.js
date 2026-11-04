const crypto = require('node:crypto');

/**
 * State and PKCE helpers for the GitHub App web application flow.
 * GitHub documents `state` (CSRF), `code_challenge` (S256 only) and `code_verifier`.
 * Pure module: randomness only, no I/O.
 */

/** 256-bit random value for the OAuth `state` parameter. */
function generateState() {
  return crypto.randomBytes(32).toString('base64url');
}

/** RFC 7636 code verifier: 32 random bytes -> 43 base64url characters (allowed range 43-128). */
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

/** code_challenge = BASE64URL(SHA256(code_verifier)); GitHub supports only the S256 method. */
function codeChallengeS256(verifier) {
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** States are stored hashed so a database read cannot be replayed against the callback. */
function hashState(state) {
  return crypto.createHash('sha256').update(String(state), 'utf8').digest('hex');
}

module.exports = { generateState, generateCodeVerifier, codeChallengeS256, hashState };
