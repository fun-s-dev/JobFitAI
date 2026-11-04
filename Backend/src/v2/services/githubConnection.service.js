const { generateState, generateCodeVerifier, codeChallengeS256, hashState } = require('../core/pkce');
const { encrypt, decrypt, parseKey, TokenCryptoError } = require('../core/tokenCrypto');
const { classifyRepository } = require('../core/githubRepoClassification');
const { createGitHubClient, GitHubAuthError, GitHubRateLimitError, RepoNotFoundError } = require('../adapters/githubClient');
const { GitHubAuthFlowError, GitHubAuthTransportError } = require('../adapters/githubAppAuth');

/** Refresh a little before the access token actually expires */
const REFRESH_SKEW_MS = 60 * 1000;
const REFRESH_LOCK_MS = 30 * 1000;
const RETURN_TO_PATTERN = /^\/(interview\/[0-9a-f]{24}\/verify)?$/;

/**
 * Service error with an HTTP status and a stable machine-readable code. Messages are safe to show.
 */
class GitHubConnectError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'GitHubConnectError';
    this.code = code;
    this.status = status;
  }
}

const ERRORS = {
  NOT_CONFIGURED: () => new GitHubConnectError('GITHUB_CONNECT_NOT_CONFIGURED', 503, 'GitHub Connect is not configured on this server.'),
  NOT_CONNECTED: () => new GitHubConnectError('GITHUB_NOT_CONNECTED', 409, 'Connect your GitHub account first.'),
  RECONNECT: () => new GitHubConnectError('GITHUB_RECONNECT_REQUIRED', 401, 'Your GitHub connection has expired or was revoked. Please connect GitHub again.'),
  RATE_LIMITED: () => new GitHubConnectError('GITHUB_RATE_LIMITED', 429, 'GitHub rate limit reached. Please try again later.'),
  UNAVAILABLE: () => new GitHubConnectError('GITHUB_UNAVAILABLE', 502, 'GitHub is not reachable right now. Please try again.'),
  REPO_NOT_FOUND: () =>
    new GitHubConnectError(
      'REPO_NOT_FOUND',
      404,
      'Repository not found, or it is private. Private repositories are not supported in this version.'
    ),
};

/**
 * GitHub Connect: GitHub App user authorization (identity-first).
 *
 * Security properties implemented here:
 *  - `state` is 256-bit random, stored hashed, single use, bound to the starting user, 10-minute TTL.
 *  - PKCE (S256); the verifier is stored encrypted and sent only during the code exchange.
 *  - Tokens are encrypted at rest, bound to the owning user (AAD) and never returned to callers.
 *  - A GitHub account can be linked to only one JobFitAI user.
 *  - Refresh tokens are single use, so refreshes are serialised (in-process + DB lock).
 *  - A 401 triggers exactly one refresh-and-retry; after that the connection must be re-established.
 *
 * @param {object} deps
 * @param {object} deps.ConnectionModel
 * @param {object} deps.StateModel
 * @param {object|null} deps.authClient  createGitHubAppAuth(...) result, or null when not configured
 * @param {string|null} deps.encryptionKeyBase64
 * @param {(token: string) => object} [deps.clientFactory] builds an Octokit-backed githubClient for a token
 * @param {() => number} [deps.now]
 * @param {object} [deps.logger]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 */
function createGitHubConnectService({
  ConnectionModel,
  StateModel,
  authClient,
  encryptionKeyBase64,
  clientFactory = (token) => createGitHubClient({ token }),
  now = Date.now,
  logger = console,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const configured = Boolean(authClient && encryptionKeyBase64);
  const key = configured ? parseKey(encryptionKeyBase64) : null;
  const refreshInFlight = new Map();

  const aadFor = (kind, userId) => `github-${kind}:${String(userId)}`;

  function requireConfigured() {
    if (!configured) throw ERRORS.NOT_CONFIGURED();
  }

  function warn(obj, msg) {
    if (logger && typeof logger.warn === 'function') logger.warn(obj, msg);
  }

  // ---------------------------------------------------------------------------------------------
  // Connect flow
  // ---------------------------------------------------------------------------------------------

  /**
   * Starts an authorization attempt. Returns the GitHub URL the browser must be sent to.
   * @param {{ userId: string, returnTo?: string }} params
   */
  async function startConnect({ userId, returnTo = '/' }) {
    requireConfigured();
    const safeReturnTo = RETURN_TO_PATTERN.test(returnTo) ? returnTo : '/';

    const state = generateState();
    const codeVerifier = generateCodeVerifier();

    // One pending attempt per user: starting again invalidates the previous one
    await StateModel.deleteMany({ user: userId });
    await StateModel.create({
      stateHash: hashState(state),
      user: userId,
      codeVerifierEnc: encrypt(codeVerifier, key, aadFor('pkce', userId)),
      returnTo: safeReturnTo,
    });

    return {
      authorizeUrl: authClient.buildAuthorizeUrl({ state, codeChallenge: codeChallengeS256(codeVerifier) }),
    };
  }

  /**
   * Validates a user's pending attempt and consumes it (single use). Never throws for bad input;
   * returns null so the caller reports one generic `invalid_state`.
   */
  async function consumeState({ userId, state }) {
    if (typeof state !== 'string' || state.length < 20 || state.length > 200) return null;

    // Atomic find-and-delete: replay, cross-user use and double submission all find nothing
    const pending = await StateModel.findOneAndDelete({ stateHash: hashState(state), user: userId });
    if (!pending) return null;

    const ageMs = now() - new Date(pending.createdAt).getTime();
    if (ageMs > 10 * 60 * 1000) return null; // belt and braces; the TTL index also removes old rows

    try {
      return {
        codeVerifier: decrypt(pending.codeVerifierEnc, key, aadFor('pkce', userId)),
        returnTo: pending.returnTo || '/',
      };
    } catch {
      return null;
    }
  }

  /**
   * Handles the GitHub redirect. Resolves to { returnTo, outcome } where outcome is 'connected' or an
   * error reason; it does not throw for expected failures (the controller turns them into a redirect).
   */
  async function completeConnect({ userId, code, state, providerError = null }) {
    requireConfigured();

    const pending = await consumeState({ userId, state });
    if (!pending) return { returnTo: '/', outcome: 'invalid_state' };
    const { returnTo, codeVerifier } = pending;

    if (providerError) {
      // e.g. access_denied when the user clicks Cancel on GitHub
      return { returnTo, outcome: providerError === 'access_denied' ? 'access_denied' : 'provider_error' };
    }
    if (typeof code !== 'string' || code.length < 5 || code.length > 500) {
      return { returnTo, outcome: 'invalid_request' };
    }

    let tokens;
    try {
      tokens = await authClient.exchangeCode({ code, codeVerifier });
    } catch (err) {
      warn({ errorName: err.name, errorCode: err.errorCode }, 'GitHub code exchange failed');
      return { returnTo, outcome: 'exchange_failed' };
    }

    let identity;
    try {
      identity = await clientFactory(tokens.accessToken).getAuthenticatedUser();
    } catch (err) {
      warn({ errorName: err.name }, 'GitHub identity lookup failed after code exchange');
      await authClient.revokeToken({ accessToken: tokens.accessToken });
      return { returnTo, outcome: 'identity_failed' };
    }

    if (!identity || !Number.isInteger(identity.id) || identity.type === 'Bot') {
      await authClient.revokeToken({ accessToken: tokens.accessToken });
      return { returnTo, outcome: 'identity_failed' };
    }

    // A GitHub account can belong to only one JobFitAI user
    const linkedElsewhere = await ConnectionModel.findOne({ githubUserId: identity.id, user: { $ne: userId } }).select('_id');
    if (linkedElsewhere) {
      await authClient.revokeToken({ accessToken: tokens.accessToken });
      return { returnTo, outcome: 'github_account_in_use' };
    }

    // Replacing a connection to a different GitHub account: revoke the old token (best effort)
    const previous = await ConnectionModel.findOne({ user: userId }).select('+accessTokenEnc');
    if (previous && previous.githubUserId !== identity.id && previous.accessTokenEnc) {
      try {
        await authClient.revokeToken({ accessToken: decrypt(previous.accessTokenEnc, key, aadFor('access', userId)) });
      } catch {
        // already unusable
      }
    }

    try {
      await ConnectionModel.findOneAndUpdate(
        { user: userId },
        {
          $set: {
            githubUserId: identity.id,
            login: identity.login,
            avatarUrl: identity.avatarUrl,
            accessTokenEnc: encrypt(tokens.accessToken, key, aadFor('access', userId)),
            refreshTokenEnc: tokens.refreshToken ? encrypt(tokens.refreshToken, key, aadFor('refresh', userId)) : null,
            accessTokenExpiresAt: tokens.accessTokenExpiresAt,
            refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
            status: 'active',
            statusReason: null,
            connectedAt: new Date(now()),
            lastRefreshedAt: null,
            refreshLockUntil: null,
          },
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
      );
    } catch (err) {
      if (err && err.code === 11000) {
        // Another request linked this GitHub account to a different user between our check and write
        await authClient.revokeToken({ accessToken: tokens.accessToken });
        return { returnTo, outcome: 'github_account_in_use' };
      }
      throw err;
    }

    return { returnTo, outcome: 'connected' };
  }

  // ---------------------------------------------------------------------------------------------
  // Status and disconnect
  // ---------------------------------------------------------------------------------------------

  /** Connection status that is safe to return to the frontend (never includes tokens). */
  async function getStatus(userId) {
    if (!configured) return { configured: false, connected: false };

    const conn = await ConnectionModel.findOne({ user: userId });
    if (!conn) return { configured: true, connected: false };

    return {
      configured: true,
      connected: conn.status === 'active',
      needsReconnect: conn.status === 'needs_reconnect',
      login: conn.login,
      avatarUrl: conn.avatarUrl,
      connectedAt: conn.connectedAt,
    };
  }

  async function disconnect(userId) {
    requireConfigured();
    const conn = await ConnectionModel.findOne({ user: userId }).select('+accessTokenEnc');
    if (!conn) {
      await StateModel.deleteMany({ user: userId });
      return { disconnected: false };
    }

    let revoked = false;
    if (conn.accessTokenEnc) {
      try {
        revoked = await authClient.revokeToken({ accessToken: decrypt(conn.accessTokenEnc, key, aadFor('access', userId)) });
      } catch {
        revoked = false;
      }
    }

    await ConnectionModel.deleteOne({ _id: conn._id });
    await StateModel.deleteMany({ user: userId });
    if (!revoked) {
      // The local record is gone either way; this tells operators the token may still be valid at GitHub
      warn({ githubUserId: conn.githubUserId }, 'GitHub token revocation was not confirmed on disconnect');
    }
    return { disconnected: true, revokedAtGitHub: revoked };
  }

  // ---------------------------------------------------------------------------------------------
  // Token lifecycle
  // ---------------------------------------------------------------------------------------------

  async function markNeedsReconnect(userId, reason) {
    await ConnectionModel.updateOne(
      { user: userId },
      { $set: { status: 'needs_reconnect', statusReason: reason, accessTokenEnc: null, refreshTokenEnc: null, refreshLockUntil: null } }
    );
  }

  function loadWithTokens(userId) {
    return ConnectionModel.findOne({ user: userId }).select('+accessTokenEnc +refreshTokenEnc');
  }

  async function performRefresh(userId) {
    const nowMs = now();
    const locked = await ConnectionModel.findOneAndUpdate(
      {
        user: userId,
        status: 'active',
        $or: [{ refreshLockUntil: null }, { refreshLockUntil: { $lt: new Date(nowMs) } }],
      },
      { $set: { refreshLockUntil: new Date(nowMs + REFRESH_LOCK_MS) } },
      { returnDocument: 'after' }
    ).select('+accessTokenEnc +refreshTokenEnc');

    if (!locked) {
      // Another process is refreshing; wait briefly for its result
      for (let attempt = 0; attempt < 6; attempt++) {
        await sleep(500);
        const fresh = await loadWithTokens(userId);
        if (!fresh || fresh.status !== 'active') throw ERRORS.RECONNECT();
        if (fresh.accessTokenExpiresAt && fresh.accessTokenExpiresAt.getTime() - now() > REFRESH_SKEW_MS) {
          return decrypt(fresh.accessTokenEnc, key, aadFor('access', userId));
        }
      }
      throw ERRORS.UNAVAILABLE();
    }

    if (!locked.refreshTokenEnc || (locked.refreshTokenExpiresAt && locked.refreshTokenExpiresAt.getTime() <= nowMs)) {
      await markNeedsReconnect(userId, locked.refreshTokenEnc ? 'expired' : 'refresh_failed');
      throw ERRORS.RECONNECT();
    }

    let refreshToken;
    try {
      refreshToken = decrypt(locked.refreshTokenEnc, key, aadFor('refresh', userId));
    } catch (err) {
      if (err instanceof TokenCryptoError) {
        await markNeedsReconnect(userId, 'refresh_failed');
        throw ERRORS.RECONNECT();
      }
      throw err;
    }

    let tokens;
    try {
      tokens = await authClient.refresh({ refreshToken });
    } catch (err) {
      if (err instanceof GitHubAuthFlowError) {
        // bad_refresh_token (expired / already used / revoked authorization): user must reconnect
        warn({ errorCode: err.errorCode }, 'GitHub refresh token rejected');
        await markNeedsReconnect(userId, 'refresh_failed');
        throw ERRORS.RECONNECT();
      }
      // Network problem: keep the connection, release the lock, let the caller retry later
      await ConnectionModel.updateOne({ user: userId }, { $set: { refreshLockUntil: null } });
      if (err instanceof GitHubAuthTransportError) throw ERRORS.UNAVAILABLE();
      throw err;
    }

    // The old refresh token is now invalid, so persist the new pair immediately
    await ConnectionModel.updateOne(
      { user: userId },
      {
        $set: {
          accessTokenEnc: encrypt(tokens.accessToken, key, aadFor('access', userId)),
          refreshTokenEnc: tokens.refreshToken ? encrypt(tokens.refreshToken, key, aadFor('refresh', userId)) : null,
          accessTokenExpiresAt: tokens.accessTokenExpiresAt,
          refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
          lastRefreshedAt: new Date(now()),
          refreshLockUntil: null,
        },
      }
    );
    return tokens.accessToken;
  }

  function refreshSingleFlight(userId) {
    const k = String(userId);
    if (!refreshInFlight.has(k)) {
      const promise = performRefresh(userId).finally(() => refreshInFlight.delete(k));
      refreshInFlight.set(k, promise);
    }
    return refreshInFlight.get(k);
  }

  /** Returns a usable access token, refreshing first when it is (about to be) expired. */
  async function getValidAccessToken(userId, { forceRefresh = false } = {}) {
    requireConfigured();
    const conn = await loadWithTokens(userId);
    if (!conn) throw ERRORS.NOT_CONNECTED();
    if (conn.status !== 'active' || !conn.accessTokenEnc) throw ERRORS.RECONNECT();

    const expiresAt = conn.accessTokenExpiresAt ? conn.accessTokenExpiresAt.getTime() : null;
    const needsRefresh = forceRefresh || (expiresAt !== null && expiresAt - now() <= REFRESH_SKEW_MS);
    if (!needsRefresh) {
      try {
        return decrypt(conn.accessTokenEnc, key, aadFor('access', userId));
      } catch (err) {
        if (err instanceof TokenCryptoError) {
          await markNeedsReconnect(userId, 'unauthorized');
          throw ERRORS.RECONNECT();
        }
        throw err;
      }
    }
    return refreshSingleFlight(userId);
  }

  function translateGitHubError(err) {
    if (err instanceof GitHubConnectError) return err;
    if (err instanceof GitHubRateLimitError) return ERRORS.RATE_LIMITED();
    if (err instanceof RepoNotFoundError) return ERRORS.REPO_NOT_FOUND();
    return err;
  }

  /**
   * Runs `fn(githubClient)` with the user's token. On 401 it refreshes once and retries; if GitHub
   * still answers 401 the authorization is gone and the connection is marked for reconnection.
   */
  async function withUserClient(userId, fn) {
    let token = await getValidAccessToken(userId);
    try {
      return await fn(clientFactory(token));
    } catch (err) {
      if (!(err instanceof GitHubAuthError)) throw translateGitHubError(err);
    }

    token = await getValidAccessToken(userId, { forceRefresh: true });
    try {
      return await fn(clientFactory(token));
    } catch (err) {
      if (err instanceof GitHubAuthError) {
        await markNeedsReconnect(userId, 'unauthorized');
        throw ERRORS.RECONNECT();
      }
      throw translateGitHubError(err);
    }
  }

  /** A client for background jobs (token fetched/refreshed at call time). */
  async function getClientForUser(userId) {
    const token = await getValidAccessToken(userId);
    return clientFactory(token);
  }

  // ---------------------------------------------------------------------------------------------
  // Repositories
  // ---------------------------------------------------------------------------------------------

  /**
   * Confirms the token still belongs to the GitHub account that was linked. Protects against a
   * connection record whose tokens were swapped, and keeps the stored login current after renames.
   */
  async function verifyIdentity(userId, client) {
    const identity = await client.getAuthenticatedUser();
    const conn = await ConnectionModel.findOne({ user: userId });
    if (!conn || identity.id !== conn.githubUserId) {
      await markNeedsReconnect(userId, 'unauthorized');
      throw ERRORS.RECONNECT();
    }
    if (identity.login !== conn.login) {
      await ConnectionModel.updateOne({ user: userId }, { $set: { login: identity.login } });
    }
    return { githubUserId: identity.id, login: identity.login };
  }

  /** The connected user's public, owned repositories, each classified (selectable or why not). */
  async function listRepositories(userId) {
    return withUserClient(userId, async (client) => {
      const identity = await verifyIdentity(userId, client);
      const raw = await client.listUserPublicRepos({ login: identity.login });
      const repos = raw.map((repo) => classifyRepository(repo, identity));
      return { login: identity.login, repos };
    });
  }

  /**
   * Resolves one repository by id for analysis. The ownership decision is made HERE from GitHub's
   * response and the verified identity - never from client-supplied data.
   */
  async function resolveRepository(userId, repoId) {
    return withUserClient(userId, async (client) => {
      const identity = await verifyIdentity(userId, client);
      const raw = await client.getRepositoryById({ repoId });
      const repo = classifyRepository(raw, identity);
      return {
        repo,
        control: repo.control.verified
          ? {
              verified: true,
              method: 'github_app_identity',
              githubUserId: identity.githubUserId,
              githubLogin: identity.login,
              repoId: repo.repoId,
              verifiedAt: new Date(now()),
            }
          : null,
      };
    });
  }

  return {
    isConfigured: () => configured,
    startConnect,
    completeConnect,
    getStatus,
    disconnect,
    getValidAccessToken,
    getClientForUser,
    listRepositories,
    resolveRepository,
  };
}

module.exports = { createGitHubConnectService, GitHubConnectError, RETURN_TO_PATTERN };
