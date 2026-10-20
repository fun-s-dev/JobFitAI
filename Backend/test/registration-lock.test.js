import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { setupTestKit, teardownTestKit } from './helpers/testKit.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const User = require('../src/models/user.model');

describe('Registration Lock & Invite Code Tests', () => {
  let kit;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    kit = await setupTestKit();
  });

  afterAll(async () => {
    process.env = originalEnv;
    await teardownTestKit();
  });

  beforeEach(async () => {
    await User.deleteMany({ email: { $in: ['open@test.com', 'closed@test.com', 'vip@test.com'] } });
  });

  it('allows registration when REGISTRATION_OPEN is true (no invite code required)', async () => {
    process.env.REGISTRATION_OPEN = 'true';
    delete process.env.INVITE_CODE;

    const res = await request(kit.app)
      .post('/api/auth/register')
      .send({
        username: 'openuser',
        email: 'open@test.com',
        password: 'Password123!',
      });

    expect(res.status).toBe(201);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe('open@test.com');
  });

  it('rejects registration with 403 when REGISTRATION_OPEN is false and no INVITE_CODE configured', async () => {
    process.env.REGISTRATION_OPEN = 'false';
    delete process.env.INVITE_CODE;

    const res = await request(kit.app)
      .post('/api/auth/register')
      .send({
        username: 'closeduser',
        email: 'closed@test.com',
        password: 'Password123!',
      });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/registration is.*closed/i);
  });

  it('rejects registration with 403 when REGISTRATION_OPEN is false and wrong or missing code is provided', async () => {
    process.env.REGISTRATION_OPEN = 'false';
    process.env.INVITE_CODE = 'vip-invite-2026';

    // Missing invite code
    const resMissing = await request(kit.app)
      .post('/api/auth/register')
      .send({
        username: 'vipuser1',
        email: 'vip@test.com',
        password: 'Password123!',
      });

    expect(resMissing.status).toBe(403);
    expect(resMissing.body.message).toMatch(/invite code is required/i);

    // Wrong invite code
    const resWrong = await request(kit.app)
      .post('/api/auth/register')
      .send({
        username: 'vipuser2',
        email: 'vip@test.com',
        password: 'Password123!',
        inviteCode: 'completely-wrong-code',
      });

    expect(resWrong.status).toBe(403);
    expect(resWrong.body.message).toMatch(/invite code is required/i);
  });

  it('accepts registration when REGISTRATION_OPEN is false and correct INVITE_CODE is provided', async () => {
    process.env.REGISTRATION_OPEN = 'false';
    process.env.INVITE_CODE = 'vip-invite-2026';

    const res = await request(kit.app)
      .post('/api/auth/register')
      .send({
        username: 'vipuser3',
        email: 'vip@test.com',
        password: 'Password123!',
        inviteCode: 'vip-invite-2026',
      });

    expect(res.status).toBe(201);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe('vip@test.com');
  });
});
