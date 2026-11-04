import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { setupTestKit, teardownTestKit } from './helpers/testKit.js';

/**
 * Rate limits are read from config when the routers load, so small limits are set BEFORE the app is
 * required. Each test file gets a fresh app (and fresh in-memory limiter stores).
 */
describe('V1 rate limiting (auth and report generation)', () => {
  let kit;
  let aiService;
  let generateSpy;

  beforeAll(async () => {
    process.env.RATE_LIMIT_LOGIN_MAX = '3'; // failed logins per window per IP
    process.env.RATE_LIMIT_REGISTER_MAX = '4'; // the test kit itself registers 2 users
    process.env.RATE_LIMIT_REPORT_MAX = '3'; // report requests per window per user
    process.env.USER_DAILY_REPORTS = '1000';
    kit = await setupTestKit();
    aiService = kit.require('../../src/services/ai.service');
    generateSpy = vi.spyOn(aiService, 'generateInterviewReport').mockResolvedValue({
      matchScore: 70,
      title: 'Backend Engineer',
      technicalQuestions: [{ question: 'Q', intention: 'I', answer: 'A' }],
      behavioralQuestions: [{ question: 'Q', intention: 'I', answer: 'A' }],
      skillGaps: [],
      preparationPlan: [{ day: 1, focus: 'F', tasks: ['T'] }],
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    for (const key of ['RATE_LIMIT_LOGIN_MAX', 'RATE_LIMIT_REGISTER_MAX', 'RATE_LIMIT_REPORT_MAX', 'USER_DAILY_REPORTS']) {
      delete process.env[key];
    }
    await teardownTestKit();
  });

  it('limits sign-ups per IP with a 429 that carries a top-level message for the frontend', async () => {
    const register = (n) =>
      request(kit.app)
        .post('/api/auth/register')
        .send({ username: `spam${n}`, email: `spam${n}@example.com`, password: 'Password123!' });

    expect((await register(1)).status).toBe(201); // 3rd registration overall (kit used 2)
    expect((await register(2)).status).toBe(201); // 4th = the limit

    const blocked = await register(3);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(blocked.body.message).toMatch(/too many sign-up attempts/i);
  });

  it('counts only FAILED logins, so successful logins never cause a lockout', async () => {
    const login = (password) =>
      request(kit.app).post('/api/auth/login').send({ email: 'alice@example.com', password });

    // Several successful logins are free
    for (let i = 0; i < 5; i++) {
      expect((await login('Password123!')).status).toBe(200);
    }

    // Three wrong passwords are tolerated, the fourth attempt is blocked
    for (let i = 0; i < 3; i++) {
      expect((await login('wrong-password-1')).status).toBe(400);
    }
    const blocked = await login('wrong-password-1');
    expect(blocked.status).toBe(429);
    expect(blocked.body.message).toMatch(/too many failed login attempts/i);

    // While locked out even the correct password is refused (brute-force protection)
    expect((await login('Password123!')).status).toBe(429);
  });

  it('limits report generation per user and does not call the AI once limited', async () => {
    const send = (agent) =>
      agent
        .post('/api/interview')
        .field('jobDescription', 'Senior Node.js backend engineer building REST APIs.')
        .field('selfDescription', 'Backend developer.');

    for (let i = 0; i < 3; i++) {
      expect((await send(kit.agentA)).status).toBe(201);
    }
    expect(generateSpy).toHaveBeenCalledTimes(3);

    const blocked = await send(kit.agentA);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(blocked.body.message).toMatch(/too many report requests/i);
    expect(generateSpy).toHaveBeenCalledTimes(3);

    // Limits are per user: another user is unaffected
    expect((await send(kit.agentB)).status).toBe(201);
  });
});
