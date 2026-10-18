import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRateLimiter } = require('../../../src/v2/middlewares/rateLimits');

describe('v2 rateLimits middleware', () => {
  it('keys authenticated requests by user id (req.user.id or req.user._id), ensuring limits are per-user and not per-IP', async () => {
    const app = express();
    app.use(express.json());

    // Rate limiter with max = 2
    const limiter = createRateLimiter({
      windowMs: 60 * 1000,
      max: 2,
      message: 'Rate limit exceeded',
    });

    // Custom test router allowing simulated user and IP injection
    app.get('/test-limit', (req, res, next) => {
      if (req.headers['x-test-user-id']) {
        // authUser populates decoded JWT token which has .id
        req.user = { id: req.headers['x-test-user-id'] };
      }
      next();
    }, limiter, (req, res) => {
      res.status(200).json({ ok: true });
    });

    // Scenario A: Same IP, different users -> independent limits
    // User A makes 2 requests from IP 1.2.3.4 (should succeed)
    await request(app)
      .get('/test-limit')
      .set('X-Forwarded-For', '1.2.3.4')
      .set('x-test-user-id', 'user_A')
      .expect(200);

    await request(app)
      .get('/test-limit')
      .set('X-Forwarded-For', '1.2.3.4')
      .set('x-test-user-id', 'user_A')
      .expect(200);

    // User A 3rd request from same IP is rate-limited
    const userABlocked = await request(app)
      .get('/test-limit')
      .set('X-Forwarded-For', '1.2.3.4')
      .set('x-test-user-id', 'user_A')
      .expect(429);
    expect(userABlocked.body.error.code).toBe('RATE_LIMIT_EXCEEDED');

    // User B from the EXACT SAME IP is NOT blocked because limits are per-user
    await request(app)
      .get('/test-limit')
      .set('X-Forwarded-For', '1.2.3.4')
      .set('x-test-user-id', 'user_B')
      .expect(200);

    // Scenario B: Same user, different IPs -> shared bucket
    // User B makes a 2nd request from a different IP 5.6.7.8 (reaches limit of 2)
    await request(app)
      .get('/test-limit')
      .set('X-Forwarded-For', '5.6.7.8')
      .set('x-test-user-id', 'user_B')
      .expect(200);

    // User B 3rd request from yet another IP 9.10.11.12 is rate-limited
    const userBBlocked = await request(app)
      .get('/test-limit')
      .set('X-Forwarded-For', '9.10.11.12')
      .set('x-test-user-id', 'user_B')
      .expect(429);
    expect(userBBlocked.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('supports req.user._id if user object is a Mongoose document or populated with _id', async () => {
    const app = express();
    const limiter = createRateLimiter({ windowMs: 60 * 1000, max: 1 });

    app.get('/test-mongoose-user', (req, res, next) => {
      req.user = { _id: 'mongoose_id_999' };
      next();
    }, limiter, (req, res) => {
      res.status(200).json({ ok: true });
    });

    await request(app).get('/test-mongoose-user').expect(200);
    const blocked = await request(app).get('/test-mongoose-user').expect(429);
    expect(blocked.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });
});
