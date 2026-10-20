import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { setupTestKit, teardownTestKit } from '../../helpers/testKit.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const VerificationRun = require('../../../src/v2/models/verificationRun.model');
const LlmCall = require('../../../src/v2/models/llmCall.model');
const InterviewReport = require('../../../src/models/interviewReport.model');
const ResumeDraft = require('../../../src/v2/models/resumeDraft.model');
const { getCfg } = require('../../../src/v2/config/env');
const { getMidnightPacific } = require('../../../src/v2/core/budgetGuards');

describe('LLM & Verification Daily Budget Guards Integration Tests', () => {
  let kit;
  let testReportId;
  let testDraftId;

  const mockDraft = {
    summary: 'Senior Software Engineer with 6 years experience.',
    experience: [
      {
        id: 'exp0',
        company: 'Stripe',
        role: 'Senior Backend Engineer',
        dates: '2021 - Present',
        bullets: [
          { id: 'exp0.b0', text: 'Built high-throughput payment ingestion pipeline using Node.js and Redis.' },
        ],
      },
    ],
    projects: [],
    skills: ['Node.js', 'Redis'],
    education: [],
  };

  const savedUserVerif = process.env.USER_DAILY_VERIFICATIONS;

  beforeAll(async () => {
    process.env.USER_DAILY_VERIFICATIONS = '3';
    kit = await setupTestKit();
  });

  afterAll(async () => {
    process.env.USER_DAILY_VERIFICATIONS = savedUserVerif;
    await teardownTestKit();
  });

  beforeEach(async () => {
    await VerificationRun.deleteMany({});
    await LlmCall.deleteMany({});
    await InterviewReport.deleteMany({});
    await ResumeDraft.deleteMany({});

    const userId = kit.userA.id || kit.userA._id;

    const report = await InterviewReport.create({
      user: userId,
      title: 'Senior Software Engineer',
      resume: 'Experienced developer with Node.js and MongoDB.',
      selfDescription: 'Full-stack engineer',
      jobDescription: 'Seeking backend developer with Node.js.',
      matchScore: 85,
    });
    testReportId = report._id.toString();

    const draft = await ResumeDraft.create({
      report: testReportId,
      user: userId,
      draft: mockDraft,
    });
    testDraftId = draft._id;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeRunDoc(extra = {}) {
    return {
      report: testReportId,
      user: kit.userA.id || kit.userA._id,
      draft: testDraftId,
      config: {
        weights: { sim: 0.3, ent: 0.4, proj: 0.3 },
        thresholds: { verified: 0.8, review: 0.5 },
      },
      ...extra,
    };
  }

  describe('User Daily Verifications Guard (default: 3 per user)', () => {
    it('allows requests when user is below daily limit and blocks on the 4th with 429 DAILY_BUDGET_REACHED', async () => {
      const midnight = getMidnightPacific();

      // Seed 3 verification runs for userA today
      await VerificationRun.insertMany([
        makeRunDoc({ createdAt: new Date(midnight.getTime() + 1000) }),
        makeRunDoc({ createdAt: new Date(midnight.getTime() + 2000) }),
        makeRunDoc({ createdAt: new Date(midnight.getTime() + 3000) }),
      ]);

      // 4th request from userA should be rejected before calling Gemini
      const res = await kit.agentA
        .post(`/api/v2/verification/${testReportId}`)
        .send({ sync: true });

      expect(res.status).toBe(429);
      expect(res.body.code).toBe('DAILY_BUDGET_REACHED');
      expect(res.body.error.code).toBe('DAILY_BUDGET_REACHED');
      expect(res.body.error.message).toMatch(/daily verification limit reached/i);
    });

    it('resets user daily verification allowance after midnight Pacific (fake clock test)', async () => {
      vi.useFakeTimers();
      // Set time to 2026-10-20 23:50 PDT -> 2026-10-21 06:50 UTC
      const day1 = new Date('2026-10-21T06:50:00.000Z');
      vi.setSystemTime(day1);

      const midnightDay1 = getMidnightPacific(day1);
      await VerificationRun.insertMany([
        makeRunDoc({ createdAt: new Date(midnightDay1.getTime() + 1000) }),
        makeRunDoc({ createdAt: new Date(midnightDay1.getTime() + 2000) }),
        makeRunDoc({ createdAt: new Date(midnightDay1.getTime() + 3000) }),
      ]);

      // Blocked on day 1
      const resBlocked = await kit.agentA
        .post(`/api/v2/verification/${testReportId}`)
        .send({ sync: true });
      expect(resBlocked.status).toBe(429);
      expect(resBlocked.body.code).toBe('DAILY_BUDGET_REACHED');

      // Advance clock by 20 minutes into day 2 (00:10 PDT -> 07:10 UTC)
      vi.advanceTimersByTime(20 * 60 * 1000);

      // Now the count for day 2 is 0 -> request proceeds past budget guard!
      const resAllowed = await kit.agentA
        .post(`/api/v2/verification/${testReportId}`)
        .send({ sync: true });

      // Must NOT be 429 DAILY_BUDGET_REACHED
      if (resAllowed.status === 429) {
        expect(resAllowed.body.code).not.toBe('DAILY_BUDGET_REACHED');
      } else {
        expect([200, 202, 503]).toContain(resAllowed.status);
      }
    });
  });

  describe('LLM Daily Generation Budget Guard (default: 400 calls)', () => {
    it('returns 429 DAILY_BUDGET_REACHED before calling Gemini when generation calls reach budget', async () => {
      const cfg = getCfg();
      const midnight = getMidnightPacific();

      // Seed 400 generation calls for the pinned model
      const calls = [];
      for (let i = 0; i < 400; i++) {
        calls.push({
          purpose: 'tailor_resume_draft',
          model: cfg.GEMINI_MODEL,
          ok: true,
          ms: 120,
          createdAt: new Date(midnight.getTime() + 1000 + i),
        });
      }
      await LlmCall.insertMany(calls);

      const res = await kit.agentA
        .post(`/api/v2/verification/${testReportId}`)
        .send({ sync: true });

      expect(res.status).toBe(429);
      expect(res.body.code).toBe('DAILY_BUDGET_REACHED');
      expect(res.body.error.message).toMatch(/LLM generation budget reached/i);
    });
  });

  describe('Embedding Daily Budget Guard (default: 800 calls)', () => {
    it('returns 429 DAILY_BUDGET_REACHED when embedding calls reach budget', async () => {
      const cfg = getCfg();
      const midnight = getMidnightPacific();

      // Seed 800 embedding calls
      const calls = [];
      for (let i = 0; i < 800; i++) {
        calls.push({
          purpose: 'embed_claims_batch',
          model: cfg.EMBEDDING_MODEL,
          ok: true,
          ms: 50,
          createdAt: new Date(midnight.getTime() + 1000 + i),
        });
      }
      await LlmCall.insertMany(calls);

      const res = await kit.agentA
        .post(`/api/v2/verification/${testReportId}`)
        .send({ sync: true });

      expect(res.status).toBe(429);
      expect(res.body.code).toBe('DAILY_BUDGET_REACHED');
      expect(res.body.error.message).toMatch(/embedding budget reached/i);
    });
  });
});
