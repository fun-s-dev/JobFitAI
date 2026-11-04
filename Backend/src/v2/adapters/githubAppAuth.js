const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API_ORIGIN = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 10000;

/**
 * Raised when GitHub answers a token request with an OAuth error (for example bad_verification_code,
 * redirect_uri_mismatch, incorrect_client_credentials, bad_refresh_token). Only the machine-readable
 * error code is kept; nothing from the request (code, secret, tokens) is ever included.
 */
class GitHubAuthFlowError extends Error {
  constructor(errorCode, description = '') {
    super(`GitHub authorization error: ${errorCode}`);
    this.name = 'GitHubAuthFlowError';
    this.errorCode = errorCode;
    this.description = description;
  }
}

class GitHubAuthTransportError extends Error {
  constructor(message = 'Could not reach GitHub') {
    super(message);
    this.name = 'GitHubAuthTransportError';
  }
}

/**
 * Adapter for the GitHub App user authorization (web application) flow.
 * This is the only module that talks to github.com/login/oauth/*; API calls on behalf of the user
 * (GET /user, repositories) go through the Octokit-based githubClient adapter.
 * Verified against GitHub docs ("Generating a user access token for a GitHub App").
 *
 * @param {object} options
 * @param {string} options.clientId
 * @param {string} options.clientSecret
 * @param {string} options.callbackUrl  Must equal one of the Callback URLs registered on the GitHub App
 * @param {Function} [options.fetchImpl=globalThis.fetch]
 * @param {() => number} [options.now=Date.now]
 */
function createGitHubAppAuth({ clientId, clientSecret, callbackUrl, fetchImpl = globalThis.fetch, now = Date.now }) {
  if (!clientId || !clientSecret || !callbackUrl) {
    throw new Error('createGitHubAppAuth requires clientId, clientSecret and callbackUrl');
  }

  function buildAuthorizeUrl({ state, codeChallenge }) {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', callbackUrl);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  async function postToken(payload) {
    let response;
    try {
      response = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, ...payload }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new GitHubAuthTransportError();
    }

    let json = null;
    try {
      json = await response.json();
    } catch {
      throw new GitHubAuthTransportError('GitHub returned an unreadable response');
    }

    // GitHub reports OAuth errors with HTTP 200 and an `error` field
    if (json && json.error) {
      throw new GitHubAuthFlowError(String(json.error), String(json.error_description || ''));
    }
    if (!response.ok || !json || typeof json.access_token !== 'string') {
      throw new GitHubAuthTransportError(`GitHub token endpoint returned status ${response.status}`);
    }
    return normalizeTokenResponse(json, now());
  }

  /** Authorization code (+ PKCE verifier) -> user access token (+ refresh token when expiry is enabled). */
  function exchangeCode({ code, codeVerifier }) {
    return postToken({ code, redirect_uri: callbackUrl, code_verifier: codeVerifier });
  }

  /** Refresh tokens are single use: the response contains a NEW refresh token that replaces the old one. */
  function refresh({ refreshToken }) {
    return postToken({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  /**
   * Best-effort revocation of one user access token (DELETE /applications/{client_id}/token).
   * Returns true when GitHub confirmed (204) or the token was already invalid (404/422).
   * NOTE: endpoint behaviour for GitHub Apps is documented under "OAuth authorizations"; confirm
   * against the live app during the real end-to-end test.
   */
  async function revokeToken({ accessToken }) {
    try {
      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const response = await fetchImpl(`${API_ORIGIN}/applications/${encodeURIComponent(clientId)}/token`, {
        method: 'DELETE',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ access_token: accessToken }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return response.status === 204 || response.status === 404 || response.status === 422;
    } catch {
      return false;
    }
  }

  return { buildAuthorizeUrl, exchangeCode, refresh, revokeToken };
}

function normalizeTokenResponse(json, nowMs) {
  const expiresIn = Number(json.expires_in);
  const refreshExpiresIn = Number(json.refresh_token_expires_in);
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : null,
    accessTokenExpiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(nowMs + expiresIn * 1000) : null,
    refreshTokenExpiresAt:
      Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0 ? new Date(nowMs + refreshExpiresIn * 1000) : null,
  };
}

module.exports = {
  createGitHubAppAuth,
  GitHubAuthFlowError,
  GitHubAuthTransportError,
  AUTHORIZE_URL,
  TOKEN_URL,
};
