import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { setupTestKit, teardownTestKit } from './helpers/testKit.js';

describe('V1 auth: request validation and safe error handling', () => {
  let kit;
  let User;
  let bcrypt;

  const validBody = (overrides = {}) => ({
    username: 'validuser',
    email: 'valid.user@example.com',
    password: 'Password123!',
    ...overrides,
  });

  beforeAll(async () => {
    // Rate limits are covered in v1-rate-limits.test.js
    process.env.RATE_LIMIT_LOGIN_MAX = '1000';
    process.env.RATE_LIMIT_REGISTER_MAX = '1000';
    kit = await setupTestKit();
    User = kit.require('../../src/models/user.model');
    bcrypt = kit.require('bcryptjs');
  });

  afterAll(async () => {
    delete process.env.RATE_LIMIT_LOGIN_MAX;
    delete process.env.RATE_LIMIT_REGISTER_MAX;
    await teardownTestKit();
  });

  describe('POST /api/auth/register', () => {
    it.each([
      ['no body fields', {}, /all fields are required/i],
      ['missing password', { username: 'validuser', email: 'valid.user@example.com' }, /all fields are required/i],
      ['invalid email', validBody({ email: 'not-an-email' }), /valid email/i],
      ['password shorter than 8 characters', validBody({ password: 'short1' }), /at least 8 characters/i],
      ['password longer than bcrypt can use (72 bytes)', validBody({ password: 'a'.repeat(73) }), /at most 72 bytes/i],
      ['username with illegal characters', validBody({ username: 'bad name!' }), /letters, numbers/i],
      ['username shorter than 3 characters', validBody({ username: 'ab' }), /at least 3 characters/i],
    ])('rejects %s with 400 and a readable message', async (_label, body, pattern) => {
      const res = await request(kit.app).post('/api/auth/register').send(body);

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(pattern);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('rejects object-valued fields (NoSQL operator injection) with 400', async () => {
      const res = await request(kit.app)
        .post('/api/auth/register')
        .send({ username: { $ne: null }, email: { $gt: '' }, password: 'Password123!' });

      expect(res.status).toBe(400);
      expect(await User.countDocuments({ username: 'validuser' })).toBe(0);
    });

    it('stores a lower-cased trimmed email and rejects a duplicate that differs only by case', async () => {
      const first = await request(kit.app)
        .post('/api/auth/register')
        .send(validBody({ username: 'caseuser', email: '  Case.User@Example.COM ' }));
      expect(first.status).toBe(201);
      expect(first.body.user.email).toBe('case.user@example.com');

      const duplicate = await request(kit.app)
        .post('/api/auth/register')
        .send(validBody({ username: 'caseuser2', email: 'CASE.USER@example.com' }));
      expect(duplicate.status).toBe(400);
      expect(duplicate.body.error.code).toBe('ACCOUNT_EXISTS');
      expect(duplicate.body.message).toMatch(/already exists/i);
    });
  });

  describe('POST /api/auth/login', () => {
    it('logs in regardless of the email letter case typed by the user', async () => {
      const res = await request(kit.app)
        .post('/api/auth/login')
        .send({ email: 'CASE.user@EXAMPLE.com', password: 'Password123!' });
      expect(res.status).toBe(200);
      expect(res.body.user.username).toBe('caseuser');
    });

    it('still logs in accounts created before email normalization (stored with mixed case)', async () => {
      await User.create({
        username: 'legacyuser',
        email: 'Legacy.User@Example.com',
        password: await bcrypt.hash('Password123!', 4),
      });

      const res = await request(kit.app)
        .post('/api/auth/login')
        .send({ email: 'Legacy.User@Example.com', password: 'Password123!' });
      expect(res.status).toBe(200);
      expect(res.body.user.username).toBe('legacyuser');
    });

    it.each([
      ['wrong password', { email: 'alice@example.com', password: 'WrongPassword1!' }],
      ['unknown email', { email: 'nobody@example.com', password: 'Password123!' }],
      ['missing password (used to crash with a 500)', { email: 'alice@example.com' }],
      ['missing email', { password: 'Password123!' }],
      ['operator injection in email', { email: { $ne: null }, password: 'Password123!' }],
      ['operator injection in password', { email: 'alice@example.com', password: { $ne: null } }],
      ['empty body', {}],
    ])('answers %s with the same generic 400', async (_label, body) => {
      const res = await request(kit.app).post('/api/auth/login').send(body);

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Invalid email or password');
      expect(res.headers['set-cookie']).toBeUndefined();
    });
  });

  describe('session and error handling', () => {
    it('returns 401 JSON from get-me when the account behind a valid token was deleted', async () => {
      const agent = request.agent(kit.app);
      const reg = await agent
        .post('/api/auth/register')
        .send(validBody({ username: 'ghostuser', email: 'ghost@example.com' }));
      expect(reg.status).toBe(201);

      await User.deleteOne({ email: 'ghost@example.com' });

      const me = await agent.get('/api/auth/get-me');
      expect(me.status).toBe(401);
      expect(me.body.error.code).toBe('UNAUTHORIZED');
    });

    it('returns a JSON 400 (not an HTML error page) for a malformed JSON body', async () => {
      const res = await request(kit.app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send('{"email": "a@b.com", "password": ');

      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.error.code).toBe('INVALID_JSON');
    });

    it('returns a JSON 404 for unknown /api routes', async () => {
      const res = await request(kit.app).get('/api/does-not-exist');
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('does not leak stack traces or internals in error responses', async () => {
      const res = await request(kit.app).post('/api/auth/login').send({});
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/stack|node_modules|at \w+ \(/i);
    });
  });
});
