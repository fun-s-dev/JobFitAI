import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import request from 'supertest';

const require = createRequire(import.meta.url);
const express = require('express');
const { encrypt, decrypt, parseKey, TokenCryptoError } = require('../../../src/v2/core/tokenCrypto');
const { generateState, generateCodeVerifier, codeChallengeS256, hashState } = require('../../../src/v2/core/pkce');
const { classifyRepository, UNSUPPORTED } = require('../../../src/v2/core/githubRepoClassification');
const { loadConfig, ConfigError, isGitHubConnectConfigured } = require('../../../src/v2/config/env');
const {
  createGitHubAppAuth,
  GitHubAuthFlowError,
  GitHubAuthTransportError,
} = require('../../../src/v2/adapters/githubAppAuth');
const { createLogger, createHttpLogger, sanitizeLoggedUrl } = require('../../../src/v2/utils/logger');

const KEY_B64 = Buffer.alloc(32, 7).toString('base64');
const KEY = parseKey(KEY_B64);

describe('core/tokenCrypto', () => {
  it('round-trips a token and produces different ciphertexts for the same input (random IV)', () => {
    const a = encrypt('ghu_secret_token_value', KEY, 'github-access:user1');
    const b = encrypt('ghu_secret_token_value', KEY, 'github-access:user1');
    expect(a).not.toBe(b);
    expect(a).not.toContain('ghu_secret_token_value');
    expect(a.startsWith('v1.')).toBe(true);
    expect(decrypt(a, KEY, 'github-access:user1')).toBe('ghu_secret_token_value');
  });

  it('fails to decrypt with another key, another owner (AAD) or tampered data - with one generic error', () => {
    const payload = encrypt('ghu_secret_token_value', KEY, 'github-access:user1');
    const otherKey = parseKey(Buffer.alloc(32, 9).toString('base64'));

    expect(() => decrypt(payload, otherKey, 'github-access:user1')).toThrow(TokenCryptoError);
    expect(() => decrypt(payload, KEY, 'github-access:user2')).toThrow(TokenCryptoError); // copied to another user
    const parts = payload.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decrypt(parts.join('.'), KEY, 'github-access:user1')).toThrow(TokenCryptoError);
    expect(() => decrypt('not-a-payload', KEY, 'x')).toThrow(TokenCryptoError);
    expect(() => decrypt(null, KEY, 'x')).toThrow(TokenCryptoError);
  });

  it('rejects keys that are not 32 bytes and empty plaintext', () => {
    expect(() => parseKey(Buffer.alloc(16).toString('base64'))).toThrow(TokenCryptoError);
    expect(() => parseKey('')).toThrow(TokenCryptoError);
    expect(() => encrypt('', KEY, 'x')).toThrow(TokenCryptoError);
  });
});

describe('core/pkce', () => {
  it('generates unguessable state and an RFC 7636-sized verifier', () => {
    const states = new Set(Array.from({ length: 50 }, generateState));
    expect(states.size).toBe(50);
    expect([...states][0].length).toBeGreaterThanOrEqual(43);
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('computes the S256 challenge exactly as RFC 7636 defines it (official test vector)', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(codeChallengeS256(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('hashes state deterministically with SHA-256 so only the hash is stored', () => {
    expect(hashState('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
    expect(hashState('abc')).not.toContain('abc');
  });
});

describe('core/githubRepoClassification', () => {
  const identity = { githubUserId: 1001 };
  const repo = (overrides = {}) => ({
    id: 5,
    name: 'app',
    full_name: 'alice-gh/app',
    html_url: 'https://github.com/alice-gh/app',
    description: 'demo',
    private: false,
    fork: false,
    archived: false,
    disabled: false,
    owner: { id: 1001, login: 'alice-gh', type: 'User' },
    ...overrides,
  });

  it('marks a public repository owned by the authenticated account as verified control', () => {
    const c = classifyRepository(repo(), identity);
    expect(c.selectable).toBe(true);
    expect(c.control).toEqual({
      verified: true,
      level: 'owner',
      basis: 'authenticated_github_account_is_repository_owner',
    });
  });

  it('keeps control, write access and authorship as separate concepts', () => {
    const c = classifyRepository(repo(), identity);
    expect(c.writeAccess).toBe('not_assessed');
    expect(c.authorship).toBe('not_assessed');
    expect(c.control.verified).toBe(true); // control does not imply authorship
  });

  it.each([
    ['private repository', { private: true }, UNSUPPORTED.PRIVATE],
    ['internal visibility', { visibility: 'internal' }, UNSUPPORTED.PRIVATE],
    ['fork', { fork: true }, UNSUPPORTED.FORK],
    ['archived repository', { archived: true }, UNSUPPORTED.ARCHIVED],
    ['disabled repository', { disabled: true }, UNSUPPORTED.DISABLED],
    ['repository owned by someone else', { owner: { id: 2002, login: 'someone', type: 'User' } }, UNSUPPORTED.NOT_OWNED],
    ['repository owned by an organization', { owner: { id: 1001, login: 'org', type: 'Organization' } }, UNSUPPORTED.NOT_OWNED],
  ])('is not selectable: %s', (_label, overrides, reason) => {
    const c = classifyRepository(repo(overrides), identity);
    expect(c.selectable).toBe(false);
    expect(c.unsupportedReason).toBe(reason);
    expect(c.unsupportedMessage).toBeTruthy();
  });

  it('never reports verified control for a private repository, even when owned', () => {
    expect(classifyRepository(repo({ private: true }), identity).control.verified).toBe(false);
  });

  it('does not treat a matching login as ownership: only the numeric id counts', () => {
    const spoof = repo({ owner: { id: 9999, login: 'alice-gh', type: 'User' } });
    expect(classifyRepository(spoof, identity).control.verified).toBe(false);
  });
});

describe('config: GitHub Connect variables', () => {
  const base = {
    NODE_ENV: 'test',
    MONGO_URI: 'mongodb://127.0.0.1:27017/x',
    JWT_SECRET: 'x'.repeat(32),
    GOOGLE_GENAI_API_KEY: 'dummy',
  };
  const full = {
    GITHUB_APP_CLIENT_ID: 'Iv1.testclientid',
    GITHUB_APP_CLIENT_SECRET: 'test-secret',
    GITHUB_APP_CALLBACK_URL: 'http://localhost:5173/api/v2/github/connect/callback',
    GITHUB_TOKEN_ENC_KEY: KEY_B64,
  };

  it('is disabled (and valid) when none of the variables is set, including empty values from .env', () => {
    const cfg = loadConfig(base);
    expect(isGitHubConnectConfigured(cfg)).toBe(false);
    const blank = loadConfig({ ...base, GITHUB_APP_CLIENT_ID: '', GITHUB_APP_CLIENT_SECRET: '', GITHUB_APP_CALLBACK_URL: '', GITHUB_TOKEN_ENC_KEY: '' });
    expect(isGitHubConnectConfigured(blank)).toBe(false);
  });

  it('is enabled when all four are valid', () => {
    expect(isGitHubConnectConfigured(loadConfig({ ...base, ...full }))).toBe(true);
    expect(isGitHubConnectConfigured(loadConfig({ ...base, ...full, GITHUB_APP_CALLBACK_URL: 'https://app.example.com/api/v2/github/connect/callback' }))).toBe(true);
  });

  it('refuses a partial configuration and names the missing variable without printing values', () => {
    const { GITHUB_TOKEN_ENC_KEY: _omit, ...partial } = full;
    let error;
    try {
      loadConfig({ ...base, ...partial });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toMatch(/GITHUB_TOKEN_ENC_KEY is required/);
    expect(error.message).not.toContain('test-secret');
  });

  it.each([
    ['an encryption key that is not 32 bytes', { GITHUB_TOKEN_ENC_KEY: Buffer.alloc(16).toString('base64') }, /32-byte key/],
    ['a callback URL with the wrong path', { GITHUB_APP_CALLBACK_URL: 'http://localhost:5173/callback' }, /connect\/callback/],
    ['a callback URL with a query string', { GITHUB_APP_CALLBACK_URL: 'http://localhost:5173/api/v2/github/connect/callback?x=1' }, /no query/],
    ['a plain-http non-local callback URL', { GITHUB_APP_CALLBACK_URL: 'http://evil.example.com/api/v2/github/connect/callback' }, /https/],
  ])('rejects %s', (_label, override, pattern) => {
    expect(() => loadConfig({ ...base, ...full, ...override })).toThrow(pattern);
  });
});

describe('adapters/githubAppAuth (recording fake fetch at the HTTP boundary)', () => {
  const options = {
    clientId: 'Iv1.testclientid',
    clientSecret: 'super-secret-client-secret',
    callbackUrl: 'http://localhost:5173/api/v2/github/connect/callback',
  };
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('builds the exact authorize URL GitHub documents: client_id, redirect_uri, state, PKCE S256 and no scope', () => {
    const auth = createGitHubAppAuth({ ...options, fetchImpl: vi.fn() });
    const url = new URL(auth.buildAuthorizeUrl({ state: 'state-123', codeChallenge: 'challenge-abc' }));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: options.clientId,
      redirect_uri: options.callbackUrl,
      state: 'state-123',
      code_challenge: 'challenge-abc',
      code_challenge_method: 'S256',
    });
  });

  it('exchanges a code with the PKCE verifier and converts expiry seconds into dates', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ access_token: 'ghu_a', expires_in: 28800, refresh_token: 'ghr_a', refresh_token_expires_in: 15897600, token_type: 'bearer', scope: '' })
    );
    const auth = createGitHubAppAuth({ ...options, fetchImpl, now: () => 1_000_000 });

    const tokens = await auth.exchangeCode({ code: 'the-code', codeVerifier: 'the-verifier' });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://github.com/login/oauth/access_token');
    expect(init.method).toBe('POST');
    expect(init.headers.Accept).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      code: 'the-code',
      redirect_uri: options.callbackUrl,
      code_verifier: 'the-verifier',
    });
    expect(tokens.accessToken).toBe('ghu_a');
    expect(tokens.refreshToken).toBe('ghr_a');
    expect(tokens.accessTokenExpiresAt.getTime()).toBe(1_000_000 + 28800 * 1000);
    expect(tokens.refreshTokenExpiresAt.getTime()).toBe(1_000_000 + 15897600 * 1000);
  });

  it('handles non-expiring tokens (no refresh token, no expiry)', async () => {
    const auth = createGitHubAppAuth({ ...options, fetchImpl: async () => json({ access_token: 'ghu_b', token_type: 'bearer' }) });
    const tokens = await auth.exchangeCode({ code: 'c', codeVerifier: 'v' });
    expect(tokens.refreshToken).toBeNull();
    expect(tokens.accessTokenExpiresAt).toBeNull();
  });

  it('refreshes with grant_type=refresh_token', async () => {
    const fetchImpl = vi.fn(async () => json({ access_token: 'ghu_new', expires_in: 28800, refresh_token: 'ghr_new', refresh_token_expires_in: 100 }));
    const auth = createGitHubAppAuth({ ...options, fetchImpl });
    const tokens = await auth.refresh({ refreshToken: 'ghr_old' });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'ghr_old' });
    expect(tokens.refreshToken).toBe('ghr_new');
  });

  it('turns GitHub OAuth errors (HTTP 200 with an error field) into GitHubAuthFlowError without leaking secrets', async () => {
    const auth = createGitHubAppAuth({
      ...options,
      fetchImpl: async () => json({ error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' }),
    });
    const err = await auth.exchangeCode({ code: 'leaky-code-123', codeVerifier: 'leaky-verifier-456' }).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubAuthFlowError);
    expect(err.errorCode).toBe('bad_verification_code');
    expect(JSON.stringify([err.message, err.description])).not.toMatch(/leaky|super-secret/);
  });

  it('maps network failures and unreadable bodies to GitHubAuthTransportError', async () => {
    const down = createGitHubAppAuth({ ...options, fetchImpl: async () => { throw new Error('ECONNRESET'); } });
    await expect(down.exchangeCode({ code: 'c', codeVerifier: 'v' })).rejects.toBeInstanceOf(GitHubAuthTransportError);

    const html = createGitHubAppAuth({ ...options, fetchImpl: async () => new Response('<html>bad gateway</html>', { status: 502 }) });
    await expect(html.refresh({ refreshToken: 'r' })).rejects.toBeInstanceOf(GitHubAuthTransportError);
  });

  it('revokes with HTTP Basic auth (client credentials) and treats already-invalid tokens as success', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const auth = createGitHubAppAuth({ ...options, fetchImpl });

    expect(await auth.revokeToken({ accessToken: 'ghu_x' })).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://api.github.com/applications/${options.clientId}/token`);
    expect(init.method).toBe('DELETE');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64')}`);
    expect(JSON.parse(init.body)).toEqual({ access_token: 'ghu_x' });

    const gone = createGitHubAppAuth({ ...options, fetchImpl: async () => new Response(null, { status: 404 }) });
    expect(await gone.revokeToken({ accessToken: 'ghu_x' })).toBe(true);
    const failing = createGitHubAppAuth({ ...options, fetchImpl: async () => { throw new Error('offline'); } });
    expect(await failing.revokeToken({ accessToken: 'ghu_x' })).toBe(false);
  });

  it('refuses to be created without credentials', () => {
    expect(() => createGitHubAppAuth({ clientId: '', clientSecret: '', callbackUrl: '' })).toThrow();
  });
});

describe('logging: OAuth callback query is never logged', () => {
  it('sanitizeLoggedUrl hides code and state only on the callback path', () => {
    expect(sanitizeLoggedUrl('/api/v2/github/connect/callback?code=SECRET&state=ABC')).toBe('/api/v2/github/connect/callback?[REDACTED]');
    expect(sanitizeLoggedUrl('/api/v2/github/connect/callback')).toBe('/api/v2/github/connect/callback');
    expect(sanitizeLoggedUrl('/api/v2/github/repos?x=1')).toBe('/api/v2/github/repos?x=1');
  });

  it('the HTTP logger writes neither the code nor the state for the callback request', async () => {
    let logged = '';
    const stream = new Writable({
      write(chunk, _enc, cb) {
        logged += chunk.toString();
        cb();
      },
    });
    const app = express();
    app.use(createHttpLogger({ logger: createLogger({ stream, level: 'info' }) }));
    app.get('/api/v2/github/connect/callback', (_req, res) => res.status(200).json({ ok: true }));

    await request(app).get('/api/v2/github/connect/callback?code=ONE_TIME_CODE_xyz&state=STATE_VALUE_abc');

    expect(logged.length).toBeGreaterThan(0); // the request was logged...
    expect(logged).not.toContain('ONE_TIME_CODE_xyz'); // ...without the secrets
    expect(logged).not.toContain('STATE_VALUE_abc');
    expect(logged).toContain('[REDACTED]');
  });
});
