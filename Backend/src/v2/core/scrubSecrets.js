// Regex patterns for sensitive secrets
const AWS_KEY_REGEX = /\bAKIA[0-9A-Z]{16}\b/g;
const GITHUB_TOKEN_REGEX = /\b(?:ghp_[a-zA-Z0-9]{36}|gho_[a-zA-Z0-9]{36}|ghu_[a-zA-Z0-9]{36}|ghs_[a-zA-Z0-9]{36}|ghr_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{22,})\b/g;
const PRIVATE_KEY_REGEX = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/**
 * Scrubs common API keys, tokens, and private key blocks from text content.
 *
 * @param {string} content
 * @returns {string} Sanitized content
 */
function scrubSecrets(content) {
  if (typeof content !== 'string' || !content) {
    return '';
  }

  return content
    .replace(AWS_KEY_REGEX, '[SCRUBBED_AWS_KEY]')
    .replace(GITHUB_TOKEN_REGEX, '[SCRUBBED_GITHUB_TOKEN]')
    .replace(PRIVATE_KEY_REGEX, '[SCRUBBED_PRIVATE_KEY]');
}

module.exports = {
  scrubSecrets,
};
