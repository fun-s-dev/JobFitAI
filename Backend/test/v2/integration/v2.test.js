import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestKit, teardownTestKit } from '../../helpers/testKit.js';
import { createRequire } from 'node:module';
import request from 'supertest';
import express from 'express';

const require = createRequire(import.meta.url);
const mongoose = require('mongoose');
const { z } = require('zod');
const { validate } = require('../../../src/v2/middlewares/validate');
const { loadOwnedReport } = require('../../../src/v2/middlewares/loadOwnedReport');
const { createRateLimiter } = require('../../../src/v2/middlewares/rateLimits');
const InterviewReport = require('../../../src/models/interviewReport.model');

describe('v2 API & Middleware Integration Tests', () => {
  let kit;

  beforeAll(async () => {
    kit = await setupTestKit();
  });

  afterAll(async () => {
    await teardownTestKit();
  });

  describe('GET /api/v2/health & Error Boundaries', () => {
    it('returns 200 with status ok and requestId', async () => {
      const res = await kit.agentA.get('/api/v2/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.version).toBe('v2');
      expect(res.body.requestId).toBeDefined();
    });

    it('returns 404 with v2 error shape for unknown /api/v2 routes', async () => {
      const res = await kit.agentA.get('/api/v2/non-existent-route');
      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(res.body.error.requestId).toBeDefined();
      expect(res.body.error.message).toContain('/api/v2/non-existent-route');
    });
  });

  describe('validate middleware', () => {
    const testApp = express();
    testApp.use(express.json());

    const bodySchema = z.object({
      title: z.string().min(3),
      count: z.number().int().positive(),
    });

    testApp.post(
      '/test-validate',
      validate({ body: bodySchema }),
      (req, res) => {
        res.status(200).json({ success: true, data: req.body });
      }
    );

    it('passes and returns 200 on valid body', async () => {
      const res = await request(testApp)
        .post('/test-validate')
        .send({ title: 'Valid Title', count: 5 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 400 with details when body validation fails', async () => {
      const res = await request(testApp)
        .post('/test-validate')
        .send({ title: 'X', count: -1 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.length).toBeGreaterThan(0);
    });
  });

  describe('loadOwnedReport middleware', () => {
    let reportA;

    beforeAll(async () => {
      const userAId = kit.userA.id || kit.userA._id;
      reportA = await InterviewReport.create({
        user: userAId,
        resume: 'Resume content for user A',
        selfDescription: 'Self description A',
        jobDescription: 'Software engineer JD',
        title: 'Backend Engineer',
        matchScore: 85,
        status: 'completed',
      });
    });

    const testApp = express();
    testApp.use((req, res, next) => {
      // simulate auth user from session
      if (req.headers['x-test-user'] === 'userA') {
        req.user = { id: kit.userA.id || kit.userA._id };
      } else if (req.headers['x-test-user'] === 'userB') {
        req.user = { id: kit.userB.id || kit.userB._id };
      }
      next();
    });

    testApp.get('/test-report/:reportId', loadOwnedReport, (req, res) => {
      res.status(200).json({ success: true, reportId: req.report._id });
    });

    it('returns 200 when authenticated owner accesses their report', async () => {
      const res = await request(testApp)
        .get(`/test-report/${reportA._id}`)
        .set('x-test-user', 'userA');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(String(res.body.reportId)).toBe(String(reportA._id));
    });

    it('returns 404 (never 403) when user B tries to access user A report (IDOR check)', async () => {
      const res = await request(testApp)
        .get(`/test-report/${reportA._id}`)
        .set('x-test-user', 'userB');

      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 404 for invalid ObjectId parameter', async () => {
      const res = await request(testApp)
        .get('/test-report/not-a-valid-object-id')
        .set('x-test-user', 'userA');

      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 404 for valid ObjectId that does not exist', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const res = await request(testApp)
        .get(`/test-report/${fakeId}`)
        .set('x-test-user', 'userA');

      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('createRateLimiter middleware factory', () => {
    it('enforces limit and returns 429 in v2 error format when exceeded', async () => {
      const limiterApp = express();
      const limiter = createRateLimiter({
        windowMs: 60 * 1000,
        max: 2,
        message: 'Rate limit test exceeded',
      });

      limiterApp.get('/limited', limiter, (req, res) => {
        res.status(200).json({ ok: true });
      });

      // 1st request -> 200
      const res1 = await request(limiterApp).get('/limited');
      expect(res1.status).toBe(200);

      // 2nd request -> 200
      const res2 = await request(limiterApp).get('/limited');
      expect(res2.status).toBe(200);

      // 3rd request -> 429
      const res3 = await request(limiterApp).get('/limited');
      expect(res3.status).toBe(429);
      expect(res3.body.error).toBeDefined();
      expect(res3.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(res3.body.error.message).toBe('Rate limit test exceeded');
    });
  });
});
