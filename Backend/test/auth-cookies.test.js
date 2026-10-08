import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { setupTestKit, teardownTestKit } from './helpers/testKit.js';

describe('Auth Cookies & POST Logout Security Tests', () => {
  let kit;

  beforeAll(async () => {
    kit = await setupTestKit();
  });

  afterAll(async () => {
    await teardownTestKit();
  });

  it('sets secure cookie flags on register (httpOnly, sameSite=lax, max-age)', async () => {
    const res = await request(kit.app)
      .post('/api/auth/register')
      .send({
        username: 'cookieuser1',
        email: 'cookieuser1@example.com',
        password: 'Password123!',
      });

    expect(res.status).toBe(201);
    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();

    const tokenCookie = cookies.find((c) => c.startsWith('token='));
    expect(tokenCookie).toBeDefined();
    expect(tokenCookie).toMatch(/HttpOnly/i);
    expect(tokenCookie).toMatch(/SameSite=Lax/i);
    expect(tokenCookie).toMatch(/Max-Age=86400/i);
  });

  it('sets secure cookie flags on login (httpOnly, sameSite=lax, max-age)', async () => {
    const res = await request(kit.app)
      .post('/api/auth/login')
      .send({
        email: 'alice@example.com',
        password: 'Password123!',
      });

    expect(res.status).toBe(200);
    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();

    const tokenCookie = cookies.find((c) => c.startsWith('token='));
    expect(tokenCookie).toBeDefined();
    expect(tokenCookie).toMatch(/HttpOnly/i);
    expect(tokenCookie).toMatch(/SameSite=Lax/i);
    expect(tokenCookie).toMatch(/Max-Age=86400/i);
  });

  it('state-changing GET /api/auth/logout is rejected (404/405)', async () => {
    // GET logout must be rejected because logout is now POST
    const res = await kit.agentA.get('/api/auth/logout');
    expect([404, 405]).toContain(res.status);
  });

  it('POST /api/auth/logout clears token cookie and blacklists token', async () => {
    // agentA logs out via POST
    const res = await kit.agentA.post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/logged out successfully/i);

    // Verify token cookie is cleared
    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    const tokenCookie = cookies.find((c) => c.startsWith('token='));
    expect(tokenCookie).toMatch(/Expires=/i);

    // After logout, accessing protected route fails with 401
    const meRes = await kit.agentA.get('/api/auth/get-me');
    expect(meRes.status).toBe(401);
  });
});
