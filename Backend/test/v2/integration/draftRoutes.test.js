import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { setupTestKit, teardownTestKit } from '../../helpers/testKit.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const InterviewReport = require('../../../src/models/interviewReport.model');

const ResumeDraft = require('../../../src/v2/models/resumeDraft.model');
const { setDraftService } = require('../../../src/v2/controllers/draft.controller');

describe('v2 Draft Routes Integration Tests (/api/v2/drafts)', () => {
  let kit;
  let reportA;
  let reportB;

  const mockDraft = {
    summary: 'Mock tailored summary for full stack developer.',
    experience: [
      {
        id: 'exp0',
        company: 'Alpha Inc',
        role: 'Senior Software Engineer',
        dates: '2021 - Present',
        bullets: [
          { id: 'exp0.b0', text: 'Architected scalable event-driven notification service in Node.js and RabbitMQ.' },
          { id: 'exp0.b1', text: 'Slashing delivery latency by 35% across 2M daily notifications.' },
        ],
      },
    ],
    projects: [
      {
        id: 'prj0',
        name: 'JobFitAI',
        bullets: [
          { id: 'prj0.b0', text: 'Engineered resume verification engine with deterministic checks.' },
        ],
      },
    ],
    skills: ['Node.js', 'RabbitMQ', 'Express', 'MongoDB'],
    education: [
      {
        id: 'edu0',
        school: 'Tech Institute',
        degree: 'B.S. Computer Science',
        dates: '2017 - 2021',
      },
    ],
  };

  const fakeDraftService = {
    async generateDraft() {
      return mockDraft;
    },
  };

  beforeAll(async () => {
    kit = await setupTestKit();
  });

  afterAll(async () => {
    await teardownTestKit();
  });

  beforeEach(async () => {
    // Clear drafts and reports
    await ResumeDraft.deleteMany({});
    await InterviewReport.deleteMany({});

    // Inject fake draft service
    setDraftService(fakeDraftService);

    // Create Report A owned by User A
    const userAId = kit.userA._id || kit.userA.id;
    const userBId = kit.userB._id || kit.userB.id;

    reportA = await InterviewReport.create({
      user: userAId,
      resume: 'Alice resume text with 5 years Node.js experience.',
      selfDescription: 'Full stack engineer with backend focus.',
      jobDescription: 'Senior Node.js backend developer role.',
      title: 'Senior Backend Developer Report',
    });

    // Create Report B owned by User B
    reportB = await InterviewReport.create({
      user: userBId,
      resume: 'Bob resume text with Python experience.',
      selfDescription: 'Data engineer.',
      jobDescription: 'Python data engineer role.',
      title: 'Data Engineer Report',
    });
  });


  afterEach(() => {
    setDraftService(null);
  });

  describe('POST /api/v2/drafts/:reportId', () => {
    it('returns 401 when request is not authenticated', async () => {
      const unauthAgent = kit.mongoose ? require('supertest')(kit.app) : null;
      const res = await unauthAgent.post(`/api/v2/drafts/${reportA._id}`);
      expect(res.status).toBe(401);
    });

    it('returns 400 when reportId path parameter has invalid format', async () => {
      const res = await kit.agentA.post('/api/v2/drafts/invalid-not-an-objectid');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toBeDefined();
    });

    it('returns 404 (IDOR defense) when User A tries to draft for User B report', async () => {
      const res = await kit.agentA.post(`/api/v2/drafts/${reportB._id}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(res.body.error.message).toBe('Report not found');
    });

    it('creates a ResumeDraft document and returns 201 with version 1', async () => {
      const res = await kit.agentA.post(`/api/v2/drafts/${reportA._id}`);

      expect(res.status).toBe(201);
      expect(res.body.message).toBe('Resume draft created successfully');
      expect(res.body.draft).toBeDefined();
      expect(res.body.draft.experience[0].bullets[0].id).toBe('exp0.b0');
      expect(res.body.version).toBe(1);
      expect(res.body.draftId).toBeDefined();

      // Verify stored in DB
      const stored = await ResumeDraft.findById(res.body.draftId);
      expect(stored).not.toBeNull();
      expect(stored.report.toString()).toBe(reportA._id.toString());
      const userAId = kit.userA._id || kit.userA.id;
      expect(stored.user.toString()).toBe(userAId.toString());
      expect(stored.version).toBe(1);

    });

    it('increments version to 2 on subsequent draft generation for same report', async () => {
      const firstRes = await kit.agentA.post(`/api/v2/drafts/${reportA._id}`);
      expect(firstRes.status).toBe(201);
      expect(firstRes.body.version).toBe(1);

      const secondRes = await kit.agentA.post(`/api/v2/drafts/${reportA._id}`);
      expect(secondRes.status).toBe(201);
      expect(secondRes.body.version).toBe(2);

      const count = await ResumeDraft.countDocuments({ report: reportA._id });
      expect(count).toBe(2);
    });

    it('handles fake LLM 503-style error gracefully: returns v2 error shape, no raw SDK message, no stack trace, and saves nothing to ResumeDraft', async () => {
      const failingDraftService = {
        async generateDraft() {
          const err = new Error('GoogleGenAI upstream overload: 503 Service Unavailable backend failure');
          err.status = 503;
          err.statusCode = 503;
          throw err;
        },
      };
      setDraftService(failingDraftService);

      const beforeCount = await ResumeDraft.countDocuments({ report: reportA._id });

      const res = await kit.agentA.post(`/api/v2/drafts/${reportA._id}`);

      // Verify status is 503
      expect(res.status).toBe(503);

      // Verify strict v2 error shape { error: { code, message, requestId } }
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(res.body.error.requestId).toBeDefined();

      // Verify no stack trace in response
      expect(res.body.stack).toBeUndefined();
      expect(res.body.error.stack).toBeUndefined();

      // Verify no raw SDK message leaked to client
      expect(res.body.error.message).not.toContain('GoogleGenAI');
      expect(res.body.error.message).not.toContain('backend failure');
      expect(res.body.error.message).toContain('Upstream AI service is temporarily unavailable');

      // Verify NOTHING was saved to ResumeDraft
      const afterCount = await ResumeDraft.countDocuments({ report: reportA._id });
      expect(afterCount).toBe(beforeCount);
    });
  });

  describe('GET /api/v2/drafts/:reportId', () => {
    it('returns 404 when no draft has been created yet for the report', async () => {
      const res = await kit.agentA.get(`/api/v2/drafts/${reportA._id}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(res.body.error.message).toBe('No draft found for this report');
    });

    it('returns 404 (IDOR defense) when User A tries to get User B report draft', async () => {
      // Create draft for Bob's report
      const userBId = kit.userB._id || kit.userB.id;
      await ResumeDraft.create({
        report: reportB._id,
        user: userBId,
        draft: mockDraft,
        version: 1,
      });

      // Alice attempts to get Bob's draft
      const res = await kit.agentA.get(`/api/v2/drafts/${reportB._id}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns the latest version when multiple drafts exist', async () => {
      const userAId = kit.userA._id || kit.userA.id;
      // Create version 1
      await ResumeDraft.create({
        report: reportA._id,
        user: userAId,
        draft: { ...mockDraft, summary: 'Version 1 Summary' },
        version: 1,
        createdAt: new Date(Date.now() - 5000),
      });

      // Create version 2 (newer)
      await ResumeDraft.create({
        report: reportA._id,
        user: userAId,
        draft: { ...mockDraft, summary: 'Version 2 Summary' },
        version: 2,
        createdAt: new Date(),
      });

      const res = await kit.agentA.get(`/api/v2/drafts/${reportA._id}`);
      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Resume draft fetched successfully');
      expect(res.body.version).toBe(2);
      expect(res.body.draft.summary).toBe('Version 2 Summary');
    });
  });

  describe('Rate Limiter on POST /api/v2/drafts/:reportId', () => {
    it('enforces 10 requests per 15 min limit and returns 429 on 11th request', async () => {
      const userBId = kit.userB._id || kit.userB.id;
      // Create a fresh report for User B to isolate calls
      const bobReport = await InterviewReport.create({
        user: userBId,
        resume: 'Bob resume',
        jobDescription: 'Bob job',
        title: 'Bob Rate Limit Report',
      });


      // Send 10 requests as User B
      for (let i = 0; i < 10; i++) {
        const res = await kit.agentB.post(`/api/v2/drafts/${bobReport._id}`);
        expect([201, 200]).toContain(res.status);
      }

      // The 11th request MUST be rate limited with 429
      const rateLimitedRes = await kit.agentB.post(`/api/v2/drafts/${bobReport._id}`);
      expect(rateLimitedRes.status).toBe(429);
      expect(rateLimitedRes.body.error).toBeDefined();
      expect(rateLimitedRes.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(rateLimitedRes.body.error.message).toContain('Too many');
    });
  });
});
