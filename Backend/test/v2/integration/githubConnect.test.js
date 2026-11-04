import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createHash, randomBytes } from 'node:crypto';
import { setupTestKit, teardownTestKit } from '../../helpers/testKit.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * GitHub Connect: application code runs for real (routes, middleware, validation, models, encryption,
 * state/PKCE handling, refresh logic, repository classification, job creation). ONLY the two external
 * GitHub boundaries are faked:
 *   - fetch for github.com/login/oauth/* and the revoke call (the OAuth adapter's HTTP boundary)
 *   - the Octokit-backed client factory (api.github.com)
 * The fake GitHub enforces the real protocol rules: single-use authorization codes, PKCE verification,
 * redirect_uri matching, single-use rotating refresh tokens, token expiry and revocation.
 * None of this talks to the real GitHub; the live flow must be verified separately.
 */

const CLIENT_ID = 'Iv1.test-client-id';
const CLIENT_SECRET = 'test-client-secret-never-leaked';
const CALLBACK_URL = 'http://localhost:5173/api/v2/github/connect/callback';
const ENC_KEY_B64 = Buffer.alloc(32, 11).toString('base64');
const FRONTEND = 'http://localhost:5173';

const sha256url = (s) => createHash('sha256').update(s, 'ascii').digest('base64url');

function createFakeGitHub() {
  const { GitHubAuthError, RepoNotFoundError } = require('../../../src/v2/adapters/githubClient');
  let counter = 0;

  const world = {
    accounts: {
      alice: { id: 1001, login: 'alice-gh', type: 'User', avatar_url: 'https://avatars.example/alice' },
      bob: { id: 1002, login: 'bob-gh', type: 'User', avatar_url: 'https://avatars.example/bob' },
      alice2: { id: 1003, login: 'alice-second', type: 'User', avatar_url: null },
    },
    codes: new Map(),
    accessTokens: new Map(),
    refreshTokens: new Map(),
    revokedAccessTokens: [],
    revokeRequests: [],
    tokenRequests: [],
    apiCalls: [],
    repos: [],
    privateVisible: false,
    accessTtlSec: 28800,
    failRevoke: false,
  };

  world.issueCode = (accountKey, challenge, redirectUri = CALLBACK_URL) => {
    const code = `code_${++counter}_${randomBytes(6).toString('hex')}`;
    world.codes.set(code, { accountKey, challenge, redirectUri });
    return code;
  };

  function issueTokens(accountKey) {
    const access = `ghu_${randomBytes(10).toString('hex')}${++counter}`;
    const refresh = `ghr_${randomBytes(10).toString('hex')}${counter}`;
    world.accessTokens.set(access, { accountKey, expiresAt: Date.now() + world.accessTtlSec * 1000 });
    world.refreshTokens.set(refresh, { accountKey, used: false });
    return {
      access_token: access,
      expires_in: world.accessTtlSec,
      refresh_token: refresh,
      refresh_token_expires_in: 15897600,
      scope: '',
      token_type: 'bearer',
    };
  }

  const reply = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  world.fetch = async (url, init = {}) => {
    if (url === 'https://github.com/login/oauth/access_token') {
      const body = JSON.parse(init.body);
      world.tokenRequests.push(body);
      if (body.client_id !== CLIENT_ID || body.client_secret !== CLIENT_SECRET) {
        return reply({ error: 'incorrect_client_credentials' });
      }
      if (body.grant_type === 'refresh_token') {
        const entry = world.refreshTokens.get(body.refresh_token);
        if (!entry || entry.used) return reply({ error: 'bad_refresh_token' });
        entry.used = true; // refresh tokens are single use
        return reply(issueTokens(entry.accountKey));
      }
      const entry = world.codes.get(body.code);
      if (!entry) return reply({ error: 'bad_verification_code' });
      world.codes.delete(body.code); // authorization codes are single use
      if (body.redirect_uri !== entry.redirectUri) return reply({ error: 'redirect_uri_mismatch' });
      if (!body.code_verifier || sha256url(body.code_verifier) !== entry.challenge) {
        return reply({ error: 'bad_verification_code' });
      }
      return reply(issueTokens(entry.accountKey));
    }

    const revokeMatch = /^https:\/\/api\.github\.com\/applications\/([^/]+)\/token$/.exec(url);
    if (revokeMatch && init.method === 'DELETE') {
      if (world.failRevoke) throw new Error('network down');
      const expectedAuth = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
      if (init.headers.Authorization !== expectedAuth) return new Response(null, { status: 401 });
      const { access_token: token } = JSON.parse(init.body);
      world.revokeRequests.push(token);
      world.revokedAccessTokens.push(token);
      world.accessTokens.delete(token);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  };

  world.clientFactory = (token) => {
    const authed = () => {
      const entry = world.accessTokens.get(token);
      if (!entry || entry.expiresAt <= Date.now()) throw new GitHubAuthError();
      return entry;
    };
    return {
      token, // lets tests assert which token a client was built with
      async getAuthenticatedUser() {
        const entry = authed();
        world.apiCalls.push('user');
        const a = world.accounts[entry.accountKey];
        return { id: a.id, login: a.login, type: a.type, avatarUrl: a.avatar_url };
      },
      async listUserPublicRepos({ login }) {
        authed();
        world.apiCalls.push('list');
        // Like the real endpoint, never returns private repositories
        return world.repos.filter((r) => r.owner.login === login && !r.private);
      },
      async getRepositoryById({ repoId }) {
        authed();
        world.apiCalls.push('repo');
        const repo = world.repos.find((r) => r.id === repoId);
        // An identity-only token cannot see private repositories: GitHub answers 404
        if (!repo || (repo.private && !world.privateVisible)) throw new RepoNotFoundError();
        return repo;
      },
    };
  };

  world.revokeAuthorization = (accountKey) => {
    for (const [t, e] of world.accessTokens) if (e.accountKey === accountKey) world.accessTokens.delete(t);
    for (const [t, e] of world.refreshTokens) if (e.accountKey === accountKey) world.refreshTokens.delete(t);
  };
  world.latest = () => ({
    access: [...world.accessTokens.keys()].at(-1),
    refresh: [...world.refreshTokens.keys()].at(-1),
  });
  world.refreshCalls = () => world.tokenRequests.filter((r) => r.grant_type === 'refresh_token').length;

  return world;
}

const repo = (id, ownerKey, overrides = {}) => {
  const owners = {
    alice: { id: 1001, login: 'alice-gh', type: 'User' },
    bob: { id: 1002, login: 'bob-gh', type: 'User' },
  };
  const owner = owners[ownerKey];
  return {
    id,
    name: `repo-${id}`,
    full_name: `${owner.login}/repo-${id}`,
    html_url: `https://github.com/${owner.login}/repo-${id}`,
    description: 'demo repository',
    language: 'JavaScript',
    pushed_at: '2026-10-01T00:00:00Z',
    private: false,
    fork: false,
    archived: false,
    disabled: false,
    owner,
    ...overrides,
  };
};

describe('GitHub Connect (real application code, external GitHub boundary faked)', () => {
  let kit;
  let world;
  let ConnectionModel;
  let StateModel;
  let Job;
  let InterviewReport;
  let LlmCall;
  let ReportProjectLink;
  let GithubAnalysis;
  let setGithubConnectService;
  let setGithubEvidenceService;
  let createGitHubConnectService;
  let createGitHubAppAuth;
  let tokenCrypto;
  let reportA;
  let evidenceCalls;

  const silentLogger = { warn() {}, error() {}, info() {}, debug() {} };

  function buildService(overrides = {}) {
    return createGitHubConnectService({
      ConnectionModel,
      StateModel,
      authClient: createGitHubAppAuth({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        callbackUrl: CALLBACK_URL,
        fetchImpl: world.fetch,
      }),
      encryptionKeyBase64: ENC_KEY_B64,
      clientFactory: world.clientFactory,
      logger: silentLogger,
      sleep: async () => {},
      ...overrides,
    });
  }

  async function startFlow(agent, body = {}) {
    const res = await agent.post('/api/v2/github/connect/start').send(body);
    const url = res.body.authorizeUrl ? new URL(res.body.authorizeUrl) : null;
    return {
      res,
      url,
      state: url && url.searchParams.get('state'),
      challenge: url && url.searchParams.get('code_challenge'),
    };
  }

  async function connect(agent, accountKey) {
    const { state, challenge } = await startFlow(agent);
    const code = world.issueCode(accountKey, challenge);
    const cb = await agent.get(`/api/v2/github/connect/callback?code=${code}&state=${state}`);
    return { cb, code, state };
  }

  const reasonOf = (res) => new URL(res.headers.location).searchParams.get('reason');

  /** No response may ever contain a token, the client secret or the encryption key. */
  function expectNoSecrets(res) {
    const haystack = JSON.stringify([res.body, res.headers, res.text]);
    expect(haystack).not.toContain(CLIENT_SECRET);
    expect(haystack).not.toContain(ENC_KEY_B64);
    expect(haystack).not.toMatch(/ghu_[0-9a-f]{10}/);
    expect(haystack).not.toMatch(/ghr_[0-9a-f]{10}/);
    for (const t of [...world.accessTokens.keys(), ...world.refreshTokens.keys(), ...world.revokedAccessTokens]) {
      expect(haystack).not.toContain(t);
    }
  }

  const rawConnection = (userId) =>
    kit.mongoose.connection.collection('githubconnections').findOne({ user: new kit.mongoose.Types.ObjectId(String(userId)) });

  async function waitForJob(reportId, status = 'done') {
    await vi.waitFor(async () => {
      const job = await Job.findOne({ report: reportId, type: 'github_analysis' }).sort({ createdAt: -1 });
      expect(job && job.status).toBe(status);
    });
    return Job.findOne({ report: reportId, type: 'github_analysis' }).sort({ createdAt: -1 }).lean();
  }

  beforeAll(async () => {
    Object.assign(process.env, {
      GITHUB_APP_CLIENT_ID: CLIENT_ID,
      GITHUB_APP_CLIENT_SECRET: CLIENT_SECRET,
      GITHUB_APP_CALLBACK_URL: CALLBACK_URL,
      GITHUB_TOKEN_ENC_KEY: ENC_KEY_B64,
      RATE_LIMIT_GITHUB_CONNECT_MAX: '1000',
      RATE_LIMIT_GITHUB_MAX: '1000',
    });
    kit = await setupTestKit();

    ConnectionModel = require('../../../src/v2/models/githubConnection.model');
    StateModel = require('../../../src/v2/models/githubOauthState.model');
    Job = require('../../../src/v2/models/job');
    InterviewReport = require('../../../src/models/interviewReport.model');
    LlmCall = require('../../../src/v2/models/llmCall.model');
    ReportProjectLink = require('../../../src/v2/models/reportProjectLink.model');
    GithubAnalysis = require('../../../src/v2/models/githubAnalysis');
    ({ setGithubConnectService, setGithubEvidenceService } = require('../../../src/v2/controllers/github.controller'));
    ({ createGitHubConnectService } = require('../../../src/v2/services/githubConnection.service'));
    ({ createGitHubAppAuth } = require('../../../src/v2/adapters/githubAppAuth'));
    tokenCrypto = require('../../../src/v2/core/tokenCrypto');
  });

  afterAll(async () => {
    setGithubConnectService(null);
    setGithubEvidenceService(null);
    for (const k of ['GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_CALLBACK_URL', 'GITHUB_TOKEN_ENC_KEY', 'RATE_LIMIT_GITHUB_CONNECT_MAX', 'RATE_LIMIT_GITHUB_MAX', 'USER_DAILY_GITHUB_ANALYSES', 'LLM_DAILY_BUDGET']) {
      delete process.env[k];
    }
    await teardownTestKit();
  });

  beforeEach(async () => {
    world = createFakeGitHub();
    world.repos = [
      repo(1, 'alice'),
      repo(2, 'alice', { fork: true }),
      repo(3, 'alice', { archived: true }),
      repo(4, 'alice', { private: true }),
      repo(5, 'bob'),
    ];
    setGithubConnectService(buildService());

    evidenceCalls = [];
    setGithubEvidenceService({
      analyzeRepository: vi.fn(async (args) => {
        evidenceCalls.push(args);
        return { analysis: { _id: new kit.mongoose.Types.ObjectId() }, cached: false };
      }),
    });

    await Promise.all([
      ConnectionModel.deleteMany({}),
      StateModel.deleteMany({}),
      Job.deleteMany({}),
      InterviewReport.deleteMany({}),
      LlmCall.deleteMany({}),
      ReportProjectLink.deleteMany({}),
      GithubAnalysis.deleteMany({}),
    ]);
    delete process.env.USER_DAILY_GITHUB_ANALYSES;
    delete process.env.LLM_DAILY_BUDGET;

    reportA = await InterviewReport.create({
      user: kit.userA.id,
      title: 'Backend Engineer',
      jobDescription: 'Backend engineer role with Node.js and MongoDB.',
      resume: 'Built REST APIs in Node.js.',
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('starting the flow', () => {
    it('requires a logged-in user', async () => {
      const res = await request(kit.app).post('/api/v2/github/connect/start').send({});
      expect(res.status).toBe(401);
    });

    it('returns a real GitHub authorize URL with state and PKCE S256, and stores only a hash of the state', async () => {
      const { res, url, state, challenge } = await startFlow(kit.agentA);

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
      expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
      expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK_URL);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(state.length).toBeGreaterThanOrEqual(40);
      expect(challenge.length).toBe(43);
      expect(url.searchParams.has('scope')).toBe(false);
      expect(url.search).not.toContain(CLIENT_SECRET);

      const stored = await kit.mongoose.connection.collection('githuboauthstates').find({}).toArray();
      expect(stored).toHaveLength(1);
      const serialized = JSON.stringify(stored);
      expect(serialized).not.toContain(state); // only the hash is stored
      expect(stored[0].stateHash).toBe(createHash('sha256').update(state).digest('hex'));
      expect(String(stored[0].user)).toBe(String(kit.userA.id));
      expect(stored[0].codeVerifierEnc.startsWith('v1.')).toBe(true); // verifier is encrypted at rest
    });

    it('a new attempt invalidates the previous pending one', async () => {
      const first = await startFlow(kit.agentA);
      await startFlow(kit.agentA);
      const code = world.issueCode('alice', first.challenge);
      const cb = await kit.agentA.get(`/api/v2/github/connect/callback?code=${code}&state=${first.state}`);
      expect(reasonOf(cb)).toBe('invalid_state');
    });

    it('accepts only whitelisted same-site returnTo paths', async () => {
      const bad = await kit.agentA.post('/api/v2/github/connect/start').send({ returnTo: 'https://evil.example.com/' });
      expect(bad.status).toBe(400);
      const bad2 = await kit.agentA.post('/api/v2/github/connect/start').send({ returnTo: '//evil.example.com' });
      expect(bad2.status).toBe(400);

      const id = String(reportA._id);
      const ok = await kit.agentA.post('/api/v2/github/connect/start').send({ returnTo: `/interview/${id}/verify` });
      expect(ok.status).toBe(200);
      const code = world.issueCode('alice', new URL(ok.body.authorizeUrl).searchParams.get('code_challenge'));
      const cb = await kit.agentA.get(`/api/v2/github/connect/callback?code=${code}&state=${new URL(ok.body.authorizeUrl).searchParams.get('state')}`);
      expect(cb.headers.location).toBe(`${FRONTEND}/interview/${id}/verify?github=connected`);
    });

    it('the production wiring built from the environment variables works end to end up to the GitHub redirect', async () => {
      setGithubConnectService(null); // drop the injected service: use the one built from process.env
      const { res, url } = await startFlow(kit.agentA);

      expect(res.status).toBe(200);
      expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
      expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
      expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK_URL);
      expect(url.search).not.toContain(CLIENT_SECRET);
      expect(await StateModel.countDocuments({ user: kit.userA.id })).toBe(1);

      const status = await kit.agentA.get('/api/v2/github/connection');
      expect(status.body.connection).toEqual({ configured: true, connected: false });
    });

    it('reports "not configured" cleanly instead of failing when the server has no GitHub App credentials', async () => {
      setGithubConnectService(createGitHubConnectService({ ConnectionModel, StateModel, authClient: null, encryptionKeyBase64: null, logger: silentLogger }));

      const status = await kit.agentA.get('/api/v2/github/connection');
      expect(status.status).toBe(200);
      expect(status.body.connection).toEqual({ configured: false, connected: false });

      const start = await kit.agentA.post('/api/v2/github/connect/start').send({});
      expect(start.status).toBe(503);
      expect(start.body.error.code).toBe('GITHUB_CONNECT_NOT_CONFIGURED');
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('callback handling', () => {
    it('connects the authenticated GitHub account to the logged-in user and redirects to the frontend', async () => {
      const { cb, code, state } = await connect(kit.agentA, 'alice');

      expect(cb.status).toBe(302);
      expect(cb.headers.location).toBe(`${FRONTEND}/?github=connected`);
      expect(cb.headers['cache-control']).toBe('no-store');
      expect(cb.headers.location).not.toContain(code);
      expect(cb.headers.location).not.toContain(state);

      const conn = await rawConnection(kit.userA.id);
      expect(conn.githubUserId).toBe(1001);
      expect(conn.login).toBe('alice-gh');
      expect(conn.status).toBe('active');
      expect(conn.accessTokenExpiresAt.getTime()).toBeGreaterThan(Date.now() + 7 * 3600 * 1000); // ~8h
      expect(await StateModel.countDocuments()).toBe(0); // state consumed
    });

    it('stores both tokens encrypted, bound to the owning user, and never in plaintext', async () => {
      await connect(kit.agentA, 'alice');
      const { access, refresh } = world.latest();
      const conn = await rawConnection(kit.userA.id);

      expect(JSON.stringify(conn)).not.toContain(access);
      expect(JSON.stringify(conn)).not.toContain(refresh);
      expect(conn.accessTokenEnc.startsWith('v1.')).toBe(true);

      const key = tokenCrypto.parseKey(ENC_KEY_B64);
      expect(tokenCrypto.decrypt(conn.accessTokenEnc, key, `github-access:${kit.userA.id}`)).toBe(access);
      expect(tokenCrypto.decrypt(conn.refreshTokenEnc, key, `github-refresh:${kit.userA.id}`)).toBe(refresh);
      // copying the ciphertext to another user's record would not decrypt
      expect(() => tokenCrypto.decrypt(conn.accessTokenEnc, key, `github-access:${kit.userB.id}`)).toThrow();
    });

    it('never exposes tokens through the model (queries exclude them; toJSON strips them)', async () => {
      await connect(kit.agentA, 'alice');
      const plain = await ConnectionModel.findOne({ user: kit.userA.id });
      expect(plain.accessTokenEnc).toBeUndefined();
      expect(plain.refreshTokenEnc).toBeUndefined();

      const withTokens = await ConnectionModel.findOne({ user: kit.userA.id }).select('+accessTokenEnc +refreshTokenEnc');
      expect(withTokens.accessTokenEnc).toBeTruthy();
      expect(JSON.stringify(withTokens)).not.toContain('Enc');
    });

    it('enforces PKCE: GitHub rejects the exchange when the code was bound to a different challenge', async () => {
      const { state } = await startFlow(kit.agentA);
      const code = world.issueCode('alice', sha256url('some-other-verifier'));
      const cb = await kit.agentA.get(`/api/v2/github/connect/callback?code=${code}&state=${state}`);

      expect(reasonOf(cb)).toBe('exchange_failed');
      expect(await ConnectionModel.countDocuments()).toBe(0);
      // the app really did send a code_verifier
      expect(world.tokenRequests[0].code_verifier).toBeTruthy();
    });

    it('rejects an unknown state without contacting GitHub', async () => {
      await startFlow(kit.agentA);
      const code = world.issueCode('alice', sha256url('x'));
      const forged = randomBytes(32).toString('base64url');
      const cb = await kit.agentA.get(`/api/v2/github/connect/callback?code=${code}&state=${forged}`);

      expect(reasonOf(cb)).toBe('invalid_state');
      expect(world.tokenRequests).toHaveLength(0);
      expect(await ConnectionModel.countDocuments()).toBe(0);
    });

    it.each([
      ['a missing state', 'code=abcdefghij'],
      ['an empty state', 'code=abcdefghij&state='],
      ['an oversized state', `code=abcdefghij&state=${'a'.repeat(500)}`],
      ['no parameters at all', ''],
    ])('rejects %s as invalid_state', async (_label, query) => {
      const cb = await kit.agentA.get(`/api/v2/github/connect/callback?${query}`);
      expect(cb.status).toBe(302);
      expect(reasonOf(cb)).toBe('invalid_state');
      expect(world.tokenRequests).toHaveLength(0);
    });

    it('rejects a replayed state (state is single use) and keeps the first connection intact', async () => {
      const { state, challenge } = await startFlow(kit.agentA);
      const code1 = world.issueCode('alice', challenge);
      const first = await kit.agentA.get(`/api/v2/github/connect/callback?code=${code1}&state=${state}`);
      expect(first.headers.location).toContain('github=connected');

      const code2 = world.issueCode('alice', challenge);
      const replay = await kit.agentA.get(`/api/v2/github/connect/callback?code=${code2}&state=${state}`);
      expect(reasonOf(replay)).toBe('invalid_state');
      expect((await ConnectionModel.find({})).length).toBe(1);
      expect(world.tokenRequests).toHaveLength(1);
    });

    it('rejects an expired state (older than 10 minutes)', async () => {
      const { state, challenge } = await startFlow(kit.agentA);
      await kit.mongoose.connection
        .collection('githuboauthstates')
        .updateMany({}, { $set: { createdAt: new Date(Date.now() - 11 * 60 * 1000) } });

      const code = world.issueCode('alice', challenge);
      const cb = await kit.agentA.get(`/api/v2/github/connect/callback?code=${code}&state=${state}`);
      expect(reasonOf(cb)).toBe('invalid_state');
      expect(world.tokenRequests).toHaveLength(0);
    });

    it('state is bound to the user who started the flow: another logged-in user cannot complete it (login CSRF)', async () => {
      const { state, challenge } = await startFlow(kit.agentA); // victim starts the flow
      const code = world.issueCode('bob', challenge); // attacker's GitHub account code

      const attack = await kit.agentB.get(`/api/v2/github/connect/callback?code=${code}&state=${state}`);
      expect(reasonOf(attack)).toBe('invalid_state');
      expect(await ConnectionModel.countDocuments({ user: kit.userB.id })).toBe(0);
      expect(world.tokenRequests).toHaveLength(0);

      // the legitimate user can still finish their own flow afterwards
      const goodCode = world.issueCode('alice', challenge);
      const ok = await kit.agentA.get(`/api/v2/github/connect/callback?code=${goodCode}&state=${state}`);
      expect(ok.headers.location).toContain('github=connected');
    });

    it('handles the user cancelling on GitHub (access_denied) and consumes the state', async () => {
      const { state } = await startFlow(kit.agentA);
      const cb = await kit.agentA.get(`/api/v2/github/connect/callback?error=access_denied&state=${state}`);

      expect(cb.status).toBe(302);
      expect(reasonOf(cb)).toBe('access_denied');
      expect(await ConnectionModel.countDocuments()).toBe(0);
      expect(await StateModel.countDocuments()).toBe(0);
      expect(world.tokenRequests).toHaveLength(0);
    });

    it('rejects a valid state without an authorization code', async () => {
      const { state } = await startFlow(kit.agentA);
      const cb = await kit.agentA.get(`/api/v2/github/connect/callback?state=${state}`);
      expect(reasonOf(cb)).toBe('invalid_request');
      expect(world.tokenRequests).toHaveLength(0);
    });

    it('sends users without a session to the login page and does nothing else', async () => {
      const cb = await request(kit.app).get('/api/v2/github/connect/callback?code=abcdefghij&state=' + 'a'.repeat(43));
      expect(cb.status).toBe(302);
      expect(cb.headers.location).toBe(`${FRONTEND}/login`);
      expect(world.tokenRequests).toHaveLength(0);
    });

    it('fails safely when GitHub rejects the exchange (bad credentials / redirect mismatch)', async () => {
      const { state, challenge } = await startFlow(kit.agentA);
      const code = world.issueCode('alice', challenge, 'http://localhost:5173/some/other/callback');
      const cb = await kit.agentA.get(`/api/v2/github/connect/callback?code=${code}&state=${state}`);
      expect(reasonOf(cb)).toBe('exchange_failed'); // redirect_uri_mismatch at GitHub
      expect(await ConnectionModel.countDocuments()).toBe(0);
    });

    it('does not let one GitHub account be linked to two JobFitAI users, and revokes the extra token', async () => {
      await connect(kit.agentA, 'alice');

      const { cb } = await connect(kit.agentB, 'alice'); // Bob tries to attach Alice's GitHub account
      expect(reasonOf(cb)).toBe('github_account_in_use');
      expect(await ConnectionModel.countDocuments({ user: kit.userB.id })).toBe(0);
      expect(await ConnectionModel.countDocuments({ user: kit.userA.id })).toBe(1);
      expect(world.revokeRequests).toHaveLength(1); // the token issued to Bob's attempt was revoked
    });

    it('replacing the connection with a different GitHub account revokes the previous token', async () => {
      await connect(kit.agentA, 'alice');
      const firstAccess = world.latest().access;

      const { cb } = await connect(kit.agentA, 'alice2');
      expect(cb.headers.location).toContain('github=connected');
      const conn = await rawConnection(kit.userA.id);
      expect(conn.githubUserId).toBe(1003);
      expect(world.revokeRequests).toContain(firstAccess);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('connection status', () => {
    it('requires login', async () => {
      expect((await request(kit.app).get('/api/v2/github/connection')).status).toBe(401);
    });

    it('is per user and never contains tokens', async () => {
      const before = await kit.agentA.get('/api/v2/github/connection');
      expect(before.body.connection).toEqual({ configured: true, connected: false });

      await connect(kit.agentA, 'alice');
      const a = await kit.agentA.get('/api/v2/github/connection');
      expect(a.status).toBe(200);
      expect(a.headers['cache-control']).toBe('no-store');
      expect(a.body.connection).toMatchObject({ configured: true, connected: true, login: 'alice-gh' });
      expectNoSecrets(a);

      // another user never sees Alice's connection
      const b = await kit.agentB.get('/api/v2/github/connection');
      expect(b.body.connection).toEqual({ configured: true, connected: false });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('repository listing and classification', () => {
    it('requires a connection', async () => {
      const res = await kit.agentA.get('/api/v2/github/repos');
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('GITHUB_NOT_CONNECTED');
    });

    it('lists only public repositories of the connected account, classified, with the scope spelled out', async () => {
      await connect(kit.agentA, 'alice');
      const res = await kit.agentA.get('/api/v2/github/repos');

      expect(res.status).toBe(200);
      expectNoSecrets(res);
      expect(res.body.login).toBe('alice-gh');
      expect(res.body.scope).toMatchObject({ visibility: 'public_only', privateRepositories: 'unsupported' });

      const byId = Object.fromEntries(res.body.repos.map((r) => [r.repoId, r]));
      expect(Object.keys(byId).map(Number).sort()).toEqual([1, 2, 3]); // private (4) and Bob's (5) absent

      expect(byId[1]).toMatchObject({ selectable: true, visibility: 'public', control: { verified: true, level: 'owner' }, writeAccess: 'not_assessed', authorship: 'not_assessed' });
      expect(byId[2]).toMatchObject({ selectable: false, unsupportedReason: 'fork_unsupported', isFork: true });
      expect(byId[3]).toMatchObject({ selectable: false, unsupportedReason: 'archived' });
    });

    it('shows private repositories as visibly unsupported if GitHub ever exposes them (never silently selectable)', async () => {
      await connect(kit.agentA, 'alice');
      const client = world.clientFactory(world.latest().access);
      client.listUserPublicRepos = async () => world.repos.filter((r) => r.owner.login === 'alice-gh'); // includes private (4)
      setGithubConnectService(buildService({ clientFactory: () => client }));

      const res = await kit.agentA.get('/api/v2/github/repos');
      const priv = res.body.repos.find((r) => r.repoId === 4);
      expect(priv).toMatchObject({ visibility: 'private', selectable: false, unsupportedReason: 'private_unsupported' });
      expect(priv.control.verified).toBe(false);
    });

    it('requires login', async () => {
      expect((await request(kit.app).get('/api/v2/github/repos')).status).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('token expiry, refresh and revocation', () => {
    const expireAccessToken = (userId) =>
      ConnectionModel.updateOne({ user: userId }, { $set: { accessTokenExpiresAt: new Date(Date.now() - 1000) } });

    it('refreshes an expired access token before use and rotates BOTH stored tokens', async () => {
      await connect(kit.agentA, 'alice');
      const oldTokens = world.latest();
      await expireAccessToken(kit.userA.id);

      const res = await kit.agentA.get('/api/v2/github/repos');
      expect(res.status).toBe(200);
      expect(world.refreshCalls()).toBe(1);

      const newTokens = world.latest();
      expect(newTokens.access).not.toBe(oldTokens.access);
      expect(world.refreshTokens.get(oldTokens.refresh).used).toBe(true); // old refresh token was consumed

      const conn = await rawConnection(kit.userA.id);
      const key = tokenCrypto.parseKey(ENC_KEY_B64);
      expect(tokenCrypto.decrypt(conn.accessTokenEnc, key, `github-access:${kit.userA.id}`)).toBe(newTokens.access);
      expect(tokenCrypto.decrypt(conn.refreshTokenEnc, key, `github-refresh:${kit.userA.id}`)).toBe(newTokens.refresh);
      expect(conn.lastRefreshedAt).toBeInstanceOf(Date);
      expect(conn.accessTokenExpiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(conn.status).toBe('active');
    });

    it('does not refresh a token that is still valid', async () => {
      await connect(kit.agentA, 'alice');
      await kit.agentA.get('/api/v2/github/repos');
      await kit.agentA.get('/api/v2/github/repos');
      expect(world.refreshCalls()).toBe(0);
    });

    it('serialises concurrent refreshes: single-use refresh tokens are spent exactly once', async () => {
      await connect(kit.agentA, 'alice');
      await expireAccessToken(kit.userA.id);

      const results = await Promise.all([
        kit.agentA.get('/api/v2/github/repos'),
        kit.agentA.get('/api/v2/github/repos'),
        kit.agentA.get('/api/v2/github/repos'),
      ]);

      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(world.refreshCalls()).toBe(1);
      expect((await rawConnection(kit.userA.id)).status).toBe('active');
    });

    it('marks the connection as needing reconnection when GitHub rejects the refresh token, and wipes the stored tokens', async () => {
      await connect(kit.agentA, 'alice');
      world.refreshTokens.get(world.latest().refresh).used = true; // e.g. authorization revoked / token already spent
      await expireAccessToken(kit.userA.id);

      const res = await kit.agentA.get('/api/v2/github/repos');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('GITHUB_RECONNECT_REQUIRED');

      const conn = await rawConnection(kit.userA.id);
      expect(conn.status).toBe('needs_reconnect');
      expect(conn.statusReason).toBe('refresh_failed');
      expect(conn.accessTokenEnc).toBeNull();
      expect(conn.refreshTokenEnc).toBeNull();

      const status = await kit.agentA.get('/api/v2/github/connection');
      expect(status.body.connection).toMatchObject({ connected: false, needsReconnect: true });

      // further calls fail fast without contacting GitHub again
      const callsBefore = world.tokenRequests.length;
      expect((await kit.agentA.get('/api/v2/github/repos')).status).toBe(401);
      expect(world.tokenRequests.length).toBe(callsBefore);
    });

    it('handles a token invalidated at GitHub while still unexpired locally: refreshes once and retries', async () => {
      await connect(kit.agentA, 'alice');
      world.accessTokens.delete(world.latest().access); // access token revoked, refresh token still valid

      const res = await kit.agentA.get('/api/v2/github/repos');
      expect(res.status).toBe(200);
      expect(world.refreshCalls()).toBe(1);
    });

    it('handles revocation of the whole authorization at GitHub: reconnect required', async () => {
      await connect(kit.agentA, 'alice');
      world.revokeAuthorization('alice'); // user clicked "Revoke" in GitHub settings

      const res = await kit.agentA.get('/api/v2/github/repos');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('GITHUB_RECONNECT_REQUIRED');
      expect((await rawConnection(kit.userA.id)).status).toBe('needs_reconnect');
    });

    it('a stored token that no longer decrypts (wrong key) forces reconnection instead of crashing', async () => {
      await connect(kit.agentA, 'alice');
      setGithubConnectService(buildService({ encryptionKeyBase64: Buffer.alloc(32, 99).toString('base64') }));

      const res = await kit.agentA.get('/api/v2/github/repos');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('GITHUB_RECONNECT_REQUIRED');
    });

    it('detects a connection whose token belongs to a different GitHub account than the one linked', async () => {
      await connect(kit.agentA, 'alice');
      await ConnectionModel.updateOne({ user: kit.userA.id }, { $set: { githubUserId: 4242 } });

      const res = await kit.agentA.get('/api/v2/github/repos');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('GITHUB_RECONNECT_REQUIRED');
    });

    it('lets the user reconnect after a failure', async () => {
      await connect(kit.agentA, 'alice');
      world.revokeAuthorization('alice');
      await kit.agentA.get('/api/v2/github/repos'); // -> needs_reconnect

      const { cb } = await connect(kit.agentA, 'alice');
      expect(cb.headers.location).toContain('github=connected');
      expect((await kit.agentA.get('/api/v2/github/repos')).status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('disconnect', () => {
    it('requires login', async () => {
      expect((await request(kit.app).delete('/api/v2/github/connection')).status).toBe(401);
    });

    it('revokes the token at GitHub with client credentials, deletes the record and blocks further use', async () => {
      await connect(kit.agentA, 'alice');
      const { access } = world.latest();

      const res = await kit.agentA.delete('/api/v2/github/connection');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ disconnected: true, revokedAtGitHub: true });
      expect(world.revokeRequests).toEqual([access]);
      expect(await ConnectionModel.countDocuments({ user: kit.userA.id })).toBe(0);

      expect((await kit.agentA.get('/api/v2/github/repos')).status).toBe(409);
      expect((await kit.agentA.get('/api/v2/github/connection')).body.connection.connected).toBe(false);
    });

    it('still removes the local connection when GitHub cannot be reached', async () => {
      await connect(kit.agentA, 'alice');
      world.failRevoke = true;

      const res = await kit.agentA.delete('/api/v2/github/connection');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ disconnected: true, revokedAtGitHub: false });
      expect(await ConnectionModel.countDocuments({ user: kit.userA.id })).toBe(0);
    });

    it('only affects the caller: disconnecting never touches another user’s connection', async () => {
      await connect(kit.agentA, 'alice');
      await connect(kit.agentB, 'bob');

      await kit.agentB.delete('/api/v2/github/connection');
      expect(await ConnectionModel.countDocuments({ user: kit.userA.id })).toBe(1);
      expect(await ConnectionModel.countDocuments({ user: kit.userB.id })).toBe(0);
    });

    it('is harmless when nothing is connected, and clears pending attempts', async () => {
      await startFlow(kit.agentA);
      const res = await kit.agentA.delete('/api/v2/github/connection');
      expect(res.status).toBe(200);
      expect(res.body.disconnected).toBe(false);
      expect(await StateModel.countDocuments()).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('analysis of a selected repository (ownership verified server-side)', () => {
    const analyze = (agent, body) => agent.post('/api/v2/github/analyze').send(body);

    it('verifies ownership from GitHub, queues the job with control evidence and reads with the owner’s token', async () => {
      await connect(kit.agentA, 'alice');
      const { access } = world.latest();

      const res = await analyze(kit.agentA, { reportId: String(reportA._id), repoId: 1 });
      expect(res.status).toBe(202);
      expect(res.body.ownershipVerified).toBe(true);
      expectNoSecrets(res);

      const job = await waitForJob(reportA._id);
      expect(job.repoUrl).toBe('https://github.com/alice-gh/repo-1');
      expect(job.repoControl).toMatchObject({ verified: true, method: 'github_app_identity', githubUserId: 1001, githubLogin: 'alice-gh', repoId: 1 });

      expect(evidenceCalls).toHaveLength(1);
      expect(evidenceCalls[0].control.verified).toBe(true);
      expect(evidenceCalls[0].githubClient.token).toBe(access); // the owner's own token, resolved at run time
    });

    it('refuses a repository owned by someone else (403) and creates no job', async () => {
      await connect(kit.agentA, 'alice');
      const res = await analyze(kit.agentA, { reportId: String(reportA._id), repoId: 5 }); // Bob's repo
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('REPO_NOT_OWNED');
      expect(await Job.countDocuments()).toBe(0);
    });

    it('treats a private repository as unsupported: 404 to an identity-only token, 422 if ever visible', async () => {
      await connect(kit.agentA, 'alice');
      const hidden = await analyze(kit.agentA, { reportId: String(reportA._id), repoId: 4 });
      expect(hidden.status).toBe(404);
      expect(hidden.body.error.code).toBe('REPO_NOT_FOUND');
      expect(hidden.body.message).toMatch(/private repositories are not supported/i);

      world.privateVisible = true;
      const visible = await analyze(kit.agentA, { reportId: String(reportA._id), repoId: 4 });
      expect(visible.status).toBe(422);
      expect(visible.body.error.code).toBe('PRIVATE_REPOSITORY_UNSUPPORTED');
      expect(await Job.countDocuments()).toBe(0);
    });

    it.each([
      [2, 422, 'FORK_UNSUPPORTED'],
      [3, 422, 'REPO_ARCHIVED'],
      [999, 404, 'REPO_NOT_FOUND'],
    ])('rejects repoId %i with %i %s', async (repoId, status, code) => {
      await connect(kit.agentA, 'alice');
      const res = await analyze(kit.agentA, { reportId: String(reportA._id), repoId });
      expect(res.status).toBe(status);
      expect(res.body.error.code).toBe(code);
      expect(await Job.countDocuments()).toBe(0);
    });

    it('requires a GitHub connection to analyze a selected repository', async () => {
      const res = await analyze(kit.agentA, { reportId: String(reportA._id), repoId: 1 });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('GITHUB_NOT_CONNECTED');
    });

    it('cannot be used against another user’s report (IDOR) and does not even call GitHub', async () => {
      await connect(kit.agentB, 'bob');
      const callsBefore = world.apiCalls.length;
      const res = await analyze(kit.agentB, { reportId: String(reportA._id), repoId: 5 });
      expect(res.status).toBe(404);
      expect(world.apiCalls.length).toBe(callsBefore);
      expect(await Job.countDocuments()).toBe(0);
    });

    it('requires login', async () => {
      const res = await request(kit.app).post('/api/v2/github/analyze').send({ reportId: String(reportA._id), repoId: 1 });
      expect(res.status).toBe(401);
    });

    it('requires a repoId and rejects anything else', async () => {
      await connect(kit.agentA, 'alice');
      const missing = await analyze(kit.agentA, { reportId: String(reportA._id) });
      expect(missing.status).toBe(400);
      const badId = await analyze(kit.agentA, { reportId: String(reportA._id), repoId: '1; drop' });
      expect(badId.status).toBe(400);
      expect(await Job.countDocuments()).toBe(0);
    });

    it('rejects client-supplied ownership claims instead of ignoring them', async () => {
      await connect(kit.agentA, 'alice');
      const res = await analyze(kit.agentA, {
        reportId: String(reportA._id),
        repoId: 5, // Bob's repo: still not owned
        control: { verified: true, method: 'github_app_identity' },
        ownershipVerified: true,
      });
      expect(res.status).toBe(400);
      expect(await Job.countDocuments()).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('the pasted-URL mode is removed', () => {
    it.each([
      ['a valid GitHub URL', 'https://github.com/fun-s-dev/JobFitAI'],
      ['a non-GitHub URL', 'https://evil.example.com/a/b'],
    ])('rejects %s with 400, creates no job and never calls GitHub', async (_label, repoUrl) => {
      const res = await kit.agentA.post('/api/v2/github/analyze').send({ reportId: String(reportA._id), repoUrl });

      expect(res.status).toBe(400);
      expect(await Job.countDocuments()).toBe(0);
      expect(evidenceCalls).toHaveLength(0);
      expect(world.apiCalls).toEqual([]);
    });

    it('rejects a body that carries both a repoUrl and a repoId', async () => {
      await connect(kit.agentA, 'alice');
      const res = await kit.agentA
        .post('/api/v2/github/analyze')
        .send({ reportId: String(reportA._id), repoId: 1, repoUrl: 'https://github.com/alice-gh/repo-1' });
      expect(res.status).toBe(400);
      expect(await Job.countDocuments()).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('per-user analysis budget and AI budget guard on the analyze route', () => {
    const analyze = (body) => kit.agentA.post('/api/v2/github/analyze').send(body);

    it('blocks with 429 once the user’s daily GitHub analysis cap is reached and creates no job', async () => {
      process.env.USER_DAILY_GITHUB_ANALYSES = '2';
      await Job.insertMany(
        [0, 1].map(() => ({ user: kit.userA.id, report: reportA._id, type: 'github_analysis', status: 'done', repoUrl: 'https://github.com/a/b' }))
      );

      const res = await analyze({ reportId: String(reportA._id), repoId: 1 });
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('DAILY_BUDGET_REACHED');
      expect(res.body.message).toMatch(/daily github analysis limit reached/i);
      expect(await Job.countDocuments()).toBe(2);
    });

    it('another user is not affected by the first user’s cap', async () => {
      process.env.USER_DAILY_GITHUB_ANALYSES = '1';
      await Job.insertMany([{ user: kit.userA.id, report: reportA._id, type: 'github_analysis', status: 'done', repoUrl: 'https://github.com/a/b' }]);
      const reportB = await InterviewReport.create({ user: kit.userB.id, title: 'T', jobDescription: 'JD for engineer', resume: 'r' });

      const blocked = await analyze({ reportId: String(reportA._id), repoId: 1 });
      expect(blocked.status).toBe(429);
      await connect(kit.agentB, 'bob');
      const ok = await kit.agentB.post('/api/v2/github/analyze').send({ reportId: String(reportB._id), repoId: 5 });
      expect(ok.status).toBe(202);
      await waitForJob(reportB._id);
    });

    it('applies the shared AI generation budget guard to the route', async () => {
      const { getMidnightPacific } = require('../../../src/v2/core/budgetGuards');
      process.env.LLM_DAILY_BUDGET = '1';
      await LlmCall.create({ purpose: 'x', model: 'gemini-3.5-flash-lite', ok: true, ms: 1, createdAt: new Date(getMidnightPacific().getTime() + 1000) });

      const res = await analyze({ reportId: String(reportA._id), repoId: 1 });
      expect(res.status).toBe(429);
      expect(res.body.message).toMatch(/LLM generation budget reached/i);
      expect(await Job.countDocuments()).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('control evidence on the report link (real evidence service and models)', () => {
    let evidenceService;
    const fakeRepoClient = {
      getRepoMetadata: async () => ({ notModified: false, data: { private: false, archived: false, size: 10, default_branch: 'main' }, etag: null }),
      getHeadCommitSha: async () => 'sha-one',
      listLanguages: async () => ({ JavaScript: 100 }),
      getTree: async () => ({ tree: [], truncated: false, sha: 'tree' }),
      getBlobContent: async () => '',
    };

    beforeEach(() => {
      const { createGitHubEvidenceService } = require('../../../src/v2/services/githubEvidence.service');
      evidenceService = createGitHubEvidenceService({ githubClient: fakeRepoClient });
    });

    const verifiedControl = { verified: true, method: 'github_app_identity', githubUserId: 1001, githubLogin: 'alice-gh', repoId: 1, verifiedAt: new Date() };
    const run = (control) =>
      evidenceService.analyzeRepository({
        repoUrl: 'https://github.com/alice-gh/repo-1',
        reportId: String(reportA._id),
        userId: String(kit.userA.id),
        control,
      });

    it('records verified control on the link, keeps authorship "not_assessed", and a later pasted URL never downgrades it', async () => {
      await run(verifiedControl);
      let link = await ReportProjectLink.findOne({ report: reportA._id }).lean();
      expect(link.control).toMatchObject({ verified: true, method: 'github_app_identity', githubLogin: 'alice-gh' });
      expect(link.authorship).toBe('not_assessed');

      await run({ verified: false, method: 'pasted_public_url' });
      link = await ReportProjectLink.findOne({ report: reportA._id }).lean();
      expect(link.control.verified).toBe(true);
      expect(await ReportProjectLink.countDocuments({ report: reportA._id })).toBe(1);
    });

    it('records pasted URLs as unverified, and a later verified analysis upgrades the same link', async () => {
      await run(null);
      let link = await ReportProjectLink.findOne({ report: reportA._id }).lean();
      expect(link.control).toMatchObject({ verified: false, method: 'pasted_public_url' });

      await run(verifiedControl);
      link = await ReportProjectLink.findOne({ report: reportA._id }).lean();
      expect(link.control.verified).toBe(true);
    });

    it('GET analysis returns the control evidence and states that authorship is not assessed; other users get 404', async () => {
      const { analysis } = await run(verifiedControl);

      const owner = await kit.agentA.get(`/api/v2/github/analysis/${analysis._id}`);
      expect(owner.status).toBe(200);
      expect(owner.body.control).toEqual({ verified: true, method: 'github_app_identity', githubLogin: 'alice-gh' });
      expect(owner.body.authorship).toBe('not_assessed');

      const other = await kit.agentB.get(`/api/v2/github/analysis/${analysis._id}`);
      expect(other.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('linked repositories and their draft project (persisted per report)', () => {
    const GithubAnalysis = require('../../../src/v2/models/githubAnalysis');
    const ResumeDraft = require('../../../src/v2/models/resumeDraft.model');
    const verified = { verified: true, method: 'github_app_identity', githubLogin: 'alice-gh' };

    async function linkRepo(report, user, fullName, control = verified) {
      const analysis = await GithubAnalysis.create({
        repositoryUrl: `https://github.com/${fullName}`,
        repositoryFullName: fullName,
        commitSha: `sha-${fullName}`,
      });
      await ReportProjectLink.create({
        report: report._id,
        user,
        analysisId: analysis._id,
        repoUrl: `https://github.com/${fullName}`,
        control,
      });
      return analysis;
    }

    async function makeDraft(report, user, ...projectNames) {
      return ResumeDraft.create({
        report: report._id,
        user,
        draft: {
          summary: 's',
          projects: projectNames.map((name, i) => ({
            id: `prj${i}`,
            name,
            bullets: [{ id: `prj${i}.b0`, text: `${name} bullet` }],
          })),
        },
      });
    }

    const getLinks = (agent, reportId) => agent.get(`/api/v2/github/links/${reportId}`);
    const setProject = (agent, analysisId, body) => agent.put(`/api/v2/github/links/${analysisId}/project`).send(body);

    it('lists the report’s linked repositories with the matched draft project and the projects to choose from', async () => {
      await makeDraft(reportA, kit.userA.id, 'Meri Sakhi', 'Backend Ledger');
      const matching = await linkRepo(reportA, kit.userA.id, 'alice-gh/meri-sakhi');
      const other = await linkRepo(reportA, kit.userA.id, 'alice-gh/anvaya-agent');

      const res = await getLinks(kit.agentA, String(reportA._id));
      expect(res.status).toBe(200);
      expect(res.body.hasDraft).toBe(true);
      expect(res.body.draftProjects).toEqual(['Meri Sakhi', 'Backend Ledger']);

      const byId = Object.fromEntries(res.body.links.map((l) => [l.analysisId, l]));
      expect(byId[String(matching._id)]).toMatchObject({
        repositoryFullName: 'alice-gh/meri-sakhi',
        verified: true,
        matchedProject: 'Meri Sakhi',
        matchSource: 'name',
      });
      expect(byId[String(other._id)]).toMatchObject({ matchedProject: null, matchSource: 'none', explicitProjectName: null });
      expectNoSecrets(res);
    });

    it('works before any draft exists (nothing to match yet)', async () => {
      await linkRepo(reportA, kit.userA.id, 'alice-gh/meri-sakhi');
      const res = await getLinks(kit.agentA, String(reportA._id));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ hasDraft: false, draftProjects: [] });
      expect(res.body.links[0].matchedProject).toBeNull();
    });

    it('lets the user assign a repository to a draft project, and clear the choice again', async () => {
      await makeDraft(reportA, kit.userA.id, 'Meri Sakhi', 'Backend Ledger');
      const analysis = await linkRepo(reportA, kit.userA.id, 'alice-gh/Banking-System-backend');

      const set = await setProject(kit.agentA, analysis._id, { reportId: String(reportA._id), projectName: 'backend ledger' });
      expect(set.status).toBe(200);
      expect(set.body.projectName).toBe('Backend Ledger'); // stored with the draft's own spelling
      expect((await ReportProjectLink.findOne({ analysisId: analysis._id }).lean()).projectName).toBe('Backend Ledger');

      let listed = (await getLinks(kit.agentA, String(reportA._id))).body.links[0];
      expect(listed).toMatchObject({ matchedProject: 'Backend Ledger', matchSource: 'user', explicitProjectName: 'Backend Ledger' });

      const cleared = await setProject(kit.agentA, analysis._id, { reportId: String(reportA._id), projectName: null });
      expect(cleared.status).toBe(200);
      listed = (await getLinks(kit.agentA, String(reportA._id))).body.links[0];
      expect(listed).toMatchObject({ matchedProject: null, matchSource: 'none', explicitProjectName: null });
    });

    it('rejects a project that is not in the draft, and does not change the link', async () => {
      await makeDraft(reportA, kit.userA.id, 'Meri Sakhi');
      const analysis = await linkRepo(reportA, kit.userA.id, 'alice-gh/anvaya-agent');
      const res = await setProject(kit.agentA, analysis._id, { reportId: String(reportA._id), projectName: 'Totally Made Up' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PROJECT');
      expect((await ReportProjectLink.findOne({ analysisId: analysis._id }).lean()).projectName ?? null).toBeNull();
    });

    it('validates the body strictly', async () => {
      await makeDraft(reportA, kit.userA.id, 'Meri Sakhi');
      const analysis = await linkRepo(reportA, kit.userA.id, 'alice-gh/anvaya-agent');
      const extra = await setProject(kit.agentA, analysis._id, { reportId: String(reportA._id), projectName: 'Meri Sakhi', control: { verified: true } });
      expect(extra.status).toBe(400);
      const empty = await setProject(kit.agentA, analysis._id, { reportId: String(reportA._id), projectName: '   ' });
      expect(empty.status).toBe(400);
      const badId = await kit.agentA.put('/api/v2/github/links/not-an-id/project').send({ reportId: String(reportA._id), projectName: null });
      expect(badId.status).toBe(400);
    });

    it('another user cannot read or change the links of this report (404, nothing changes)', async () => {
      await makeDraft(reportA, kit.userA.id, 'Meri Sakhi');
      const analysis = await linkRepo(reportA, kit.userA.id, 'alice-gh/meri-sakhi');

      expect((await getLinks(kit.agentB, String(reportA._id))).status).toBe(404);
      const put = await setProject(kit.agentB, analysis._id, { reportId: String(reportA._id), projectName: 'Meri Sakhi' });
      expect(put.status).toBe(404);
      expect((await ReportProjectLink.findOne({ analysisId: analysis._id }).lean()).projectName ?? null).toBeNull();
    });

    it('a link of another report cannot be changed through this report (404)', async () => {
      const reportA2 = await InterviewReport.create({ user: kit.userA.id, title: 'T2', jobDescription: 'JD for engineer', resume: 'r' });
      await makeDraft(reportA, kit.userA.id, 'Meri Sakhi');
      const otherReportsLink = await linkRepo(reportA2, kit.userA.id, 'alice-gh/meri-sakhi');
      const res = await setProject(kit.agentA, otherReportsLink._id, { reportId: String(reportA._id), projectName: 'Meri Sakhi' });
      expect(res.status).toBe(404);
    });

    it('requires login', async () => {
      expect((await request(kit.app).get(`/api/v2/github/links/${reportA._id}`)).status).toBe(401);
      expect(
        (await request(kit.app).put(`/api/v2/github/links/${reportA._id}/project`).send({ reportId: String(reportA._id), projectName: null })).status
      ).toBe(401);
    });
  });
});
