import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { setupTestKit, teardownTestKit } from '../../helpers/testKit.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const InterviewReport = require('../../../src/models/interviewReport.model');
const ResumeDraft = require('../../../src/v2/models/resumeDraft.model');
const VerificationRun = require('../../../src/v2/models/verificationRun.model');
const ResumeClaim = require('../../../src/v2/models/resumeClaim.model');
const { setVerificationService, setVerificationSyncMode } = require('../../../src/v2/controllers/verification.controller');
const { createVerificationService } = require('../../../src/v2/services/verification.service');

describe('v2 Verification Routes Integration Tests (/api/v2/verification)', () => {
  let kit;
  let reportA;
  let reportB;

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
          { id: 'exp0.b1', text: 'Reduced p99 checkout latency by 45% across 10M daily transactions.' },
        ],
      },
    ],
    projects: [
      {
        id: 'prj0',
        name: 'JobFitAI',
        bullets: [
          { id: 'prj0.b0', text: 'Engineered verification engine with natural language inference.' },
        ],
      },
    ],
    skills: ['Node.js', 'Redis', 'Express', 'MongoDB'],
    education: [
      {
        id: 'edu0',
        school: 'University',
        degree: 'B.S. Software Engineering',
        dates: '2017 - 2021',
      },
    ],
  };

  function createMockPipelineServices({ failOnClaimIndex = null } = {}) {
    let claimCounter = 0;

    const mockEvidenceMatching = {
      prepareEvidenceChunks: async (chunks) => ({
        chunksWithVectors: chunks.map((c, i) => ({
          chunk: c,
          vector: [0.1 * (i + 1), 0.2, 0.3],
        })),
        stats: { hits: 0, misses: 0, apiCalls: 1 },
      }),
      matchClaim: async (claimText, chunksWithVectors) => [
        {
          chunk: chunksWithVectors[0]?.chunk || { id: 'c1', text: 'Built Node.js payment backend', section: 'Experience' },
          rawCosine: 0.85,
          similarityScore: 0.875,
        },
      ],
    };

    const mockEntailment = {
      evaluateClaim: async ({ claim }) => {
        claimCounter++;
        if (failOnClaimIndex !== null && claimCounter === failOnClaimIndex) {
          throw new Error('Gemini upstream transient outage (503 Service Unavailable)');
        }

        // Return yes for b0, partial for b1 (metric), yes for prj0
        if (claim.bulletId === 'exp0.b1') {
          return {
            verdict: 'partial',
            rawVerdict: 'partial',
            evidenceQuote: 'Reduced p99 checkout latency',
            missingElements: ['across 10M daily transactions'],
            quoteUngrounded: false,
            caps: [],
            entailmentScore: 0.5,
          };
        }

        return {
          verdict: 'yes',
          rawVerdict: 'yes',
          evidenceQuote: 'Built payment ingestion pipeline',
          missingElements: [],
          quoteUngrounded: false,
          caps: [],
          entailmentScore: 1.0,
        };
      },
    };

    const mockClaimExtraction = {
      extractClaimsFromBullets: async (bullets) => ({
        claims: bullets.map((b) => ({
          bulletId: b.id,
          claimText: b.text,
          claimType: 'technology',
          skills: ['Node.js'],
          numbers: b.id === 'exp0.b1' ? ['45%', '10M'] : [],
        })),
        incompleteBullets: [],
      }),
    };

    return createVerificationService({
      evidenceMatchingService: mockEvidenceMatching,
      entailmentService: mockEntailment,
      claimExtractionService: mockClaimExtraction,
    });
  }

  beforeAll(async () => {
    kit = await setupTestKit();
  });

  afterAll(async () => {
    await teardownTestKit();
  });

  beforeEach(async () => {
    await VerificationRun.deleteMany({});
    await ResumeClaim.deleteMany({});
    await ResumeDraft.deleteMany({});
    await InterviewReport.deleteMany({});

    const userAId = kit.userA._id || kit.userA.id;
    const userBId = kit.userB._id || kit.userB.id;

    // Report A owned by User A
    reportA = await InterviewReport.create({
      user: userAId,
      resume: 'Alice resume: Built payment pipeline in Node.js and Redis. Reduced p99 checkout latency by 45%.',
      selfDescription: 'Senior backend architect specializing in distributed payments.',
      jobDescription: 'Senior Backend Engineer role.',
      title: 'Senior Backend Engineer Report',
    });

    // Draft A for Report A
    await ResumeDraft.create({
      report: reportA._id,
      user: userAId,
      draft: mockDraft,
      version: 1,
    });

    // Report B owned by User B
    reportB = await InterviewReport.create({
      user: userBId,
      resume: 'Bob resume: Data science and Python pipelines.',
      selfDescription: 'Data Scientist.',
      jobDescription: 'Machine Learning Engineer role.',
      title: 'ML Engineer Report',
    });

    await ResumeDraft.create({
      report: reportB._id,
      user: userBId,
      draft: mockDraft,
      version: 1,
    });

    // Enable synchronous verification path for M5 test assertions
    setVerificationSyncMode(true);
    // Default mock pipeline
    setVerificationService(createMockPipelineServices());
  });

  afterEach(() => {
    setVerificationSyncMode(false);
    setVerificationService(null);
  });

  describe('Full verification flow & persistence', () => {
    it('executes verification, stores claims with full provenance, and returns run with claims', async () => {
      const res = await kit.agentA
        .post(`/api/v2/verification/${reportA._id}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.run).toBeDefined();
      expect(res.body.run._id).toBeDefined();
      expect(res.body.run.counts).toBeDefined();
      expect(res.body.claims).toBeDefined();
      expect(res.body.claims.length).toBe(3);

      // Verify database persistence
      const savedRun = await VerificationRun.findById(res.body.run._id);
      expect(savedRun).toBeDefined();
      expect(savedRun.report.toString()).toBe(reportA._id.toString());
      expect(savedRun.config.weights).toBeDefined();
      expect(savedRun.config.weights.W_SIM_NOGH).toBe(0.40);

      const savedClaims = await ResumeClaim.find({ run: savedRun._id });
      expect(savedClaims.length).toBe(3);

      // Check provenance
      const firstClaim = savedClaims[0];
      expect(firstClaim.provenance).toBeDefined();
      expect(firstClaim.provenance.weights).toBeDefined();
      expect(firstClaim.provenance.thresholds).toBeDefined();
      expect(firstClaim.provenance.verifiedAt).toBeDefined();
      expect(firstClaim.status).toBe('verified');
      expect(firstClaim.userOverride).toBeNull();
    });

    it('retrieves verification run and claims via GET /api/v2/verification/:reportId', async () => {
      // First, run verification
      await kit.agentA.post(`/api/v2/verification/${reportA._id}`).send({});

      // Fetch latest
      const res = await kit.agentA.get(`/api/v2/verification/${reportA._id}`);
      expect(res.status).toBe(200);
      expect(res.body.run).toBeDefined();
      expect(res.body.claims).toBeDefined();
      expect(res.body.claims.length).toBe(3);

      // Fetch by ?runId=
      const runId = res.body.run._id;
      const resWithRunId = await kit.agentA.get(`/api/v2/verification/${reportA._id}?runId=${runId}`);
      expect(resWithRunId.status).toBe(200);
      expect(resWithRunId.body.run._id).toBe(runId);
    });

    it('returns 409 draft_required if no ResumeDraft exists for the report', async () => {
      // Delete draftA
      await ResumeDraft.deleteMany({});

      const res = await kit.agentA
        .post(`/api/v2/verification/${reportA._id}`)
        .send({});

      expect(res.status).toBe(409);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('draft_required');
    });

    it('supports double-submission cleanly without data corruption', async () => {
      const res1 = await kit.agentA.post(`/api/v2/verification/${reportA._id}`).send({});
      const res2 = await kit.agentA.post(`/api/v2/verification/${reportA._id}`).send({});

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res1.body.run._id).not.toBe(res2.body.run._id);

      const runs = await VerificationRun.find({ report: reportA._id });
      expect(runs.length).toBe(2);

      const claimsRun1 = await ResumeClaim.find({ run: res1.body.run._id });
      const claimsRun2 = await ResumeClaim.find({ run: res2.body.run._id });
      expect(claimsRun1.length).toBe(3);
      expect(claimsRun2.length).toBe(3);
    });
  });

  describe('Audit trail & userOverride immutability', () => {
    it('PATCH /claim/:claimId updates userOverride without altering automated status', async () => {
      // Run verification
      const verifyRes = await kit.agentA.post(`/api/v2/verification/${reportA._id}`).send({});
      const targetClaim = verifyRes.body.claims.find((c) => c.bulletId === 'exp0.b1');
      expect(targetClaim.status).toBe('needs_review');

      // User approves the claim
      const patchRes = await kit.agentA
        .patch(`/api/v2/verification/claim/${targetClaim._id}`)
        .send({ decision: 'approved' });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.effectiveStatus).toBe('approved');
      expect(patchRes.body.claim.userOverride.decision).toBe('approved');

      // Verify in MongoDB: automated status MUST remain 'needs_review'
      const updatedClaim = await ResumeClaim.findById(targetClaim._id);
      expect(updatedClaim.status).toBe('needs_review');
      expect(updatedClaim.userOverride.decision).toBe('approved');
      expect(updatedClaim.effectiveStatus).toBe('approved');
    });

    it('PATCH rejects or ignores external status field, preserving automated status and rejecting updateOne status mutations', async () => {
      const verifyRes = await kit.agentA.post(`/api/v2/verification/${reportA._id}`).send({});
      const targetClaim = verifyRes.body.claims.find((c) => c.bulletId === 'exp0.b1');
      expect(targetClaim.status).toBe('needs_review');

      // Attempt to pass malicious status in body
      const patchRes = await kit.agentA
        .patch(`/api/v2/verification/claim/${targetClaim._id}`)
        .send({ decision: 'approved', status: 'verified' });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.claim.status).toBe('needs_review');

      // Verify DB status remains needs_review
      const claimInDb = await ResumeClaim.findById(targetClaim._id);
      expect(claimInDb.status).toBe('needs_review');

      // Direct query-level update attempt to modify status directly must fail via pre-update hook
      await expect(
        ResumeClaim.updateOne({ _id: targetClaim._id }, { status: 'verified' })
      ).rejects.toThrow('Automated status is immutable and cannot be updated');
    });
  });

  describe('Ownership & IDOR security (404 on foreign access)', () => {
    it('User B cannot verify User A report (POST -> 404)', async () => {
      const res = await kit.agentB
        .post(`/api/v2/verification/${reportA._id}`)
        .send({});

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('User B cannot read User A verification run (GET -> 404)', async () => {
      await VerificationRun.create({
        report: reportA._id,
        user: kit.userA._id || kit.userA.id,
        draft: reportA._id,
        config: { weights: {}, thresholds: {} },
        counts: { verified: 1, needsReview: 0, rejected: 0 },
      });

      const res = await kit.agentB.get(`/api/v2/verification/${reportA._id}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('User B cannot override User A claim (PATCH -> 404)', async () => {
      const run = await VerificationRun.create({
        report: reportA._id,
        user: kit.userA._id || kit.userA.id,
        draft: reportA._id,
        config: { weights: {}, thresholds: {} },
        counts: { verified: 1, needsReview: 0, rejected: 0 },
      });
      const claim = await ResumeClaim.create({
        run: run._id,
        report: reportA._id,
        user: kit.userA._id || kit.userA.id,
        bulletId: 'b1',
        claimText: 'User A private claim',
        entailment: { verdict: 'yes', score: 1 },
        confidenceScore: 0.9,
        status: 'verified',
        provenance: { weights: {}, thresholds: {} },
      });

      const res = await kit.agentB
        .patch(`/api/v2/verification/claim/${claim._id}`)
        .send({ decision: 'approved' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');

      // Claim should remain un-overridden
      const unmutatedClaim = await ResumeClaim.findById(claim._id);
      expect(unmutatedClaim.userOverride).toBeNull();
    });
  });

  describe('All-or-nothing failure resilience', () => {
    it('yields 503 with Retry-After and stores ZERO claims when LLM fails on 3rd claim', async () => {
      // Inject failure on the 3rd claim
      setVerificationService(createMockPipelineServices({ failOnClaimIndex: 3 }));

      const res = await kit.agentA
        .post(`/api/v2/verification/${reportA._id}`)
        .send({});

      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBeDefined();
      expect(res.body.error.code).toBe('UPSTREAM_UNAVAILABLE');

      // CRITICAL ASSERTION: ZERO claims stored in MongoDB
      const storedClaims = await ResumeClaim.find({ report: reportA._id });
      expect(storedClaims.length).toBe(0);

      // ZERO verification runs stored
      const storedRuns = await VerificationRun.find({ report: reportA._id });
      expect(storedRuns.length).toBe(0);
    });

    it('rolls back completely and leaves ZERO runs or claims when failure occurs DURING persistence (insertMany failure)', async () => {
      const spy = vi.spyOn(ResumeClaim, 'insertMany').mockRejectedValueOnce(new Error('Simulated Mongo disk write failure'));

      try {
        const res = await kit.agentA
          .post(`/api/v2/verification/${reportA._id}`)
          .send({});

        expect(res.status).toBe(503);
        expect(res.headers['retry-after']).toBeDefined();
        expect(res.body.error.code).toBe('UPSTREAM_UNAVAILABLE');

        // Verify that the rollback deleted the run that was created before insertMany failed
        const runs = await VerificationRun.find({ report: reportA._id });
        expect(runs.length).toBe(0);

        const claims = await ResumeClaim.find({ report: reportA._id });
        expect(claims.length).toBe(0);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('Rate limiting (POST /api/v2/verification/:reportId)', () => {
    it('enforces rate limit of 10 requests per window and returns 429 RATE_LIMIT_EXCEEDED on the 11th', async () => {
      let hit429 = false;
      let count = 0;
      for (let i = 0; i < 15; i++) {
        const res = await kit.agentB.post(`/api/v2/verification/${reportB._id}`).send({});
        count++;
        if (res.status === 429) {
          hit429 = true;
          expect(res.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
          expect(res.body.error.message).toContain('Too many verification requests');
          break;
        }
      }
      expect(hit429).toBe(true);
      expect(count).toBe(10); // 1 request from earlier IDOR test + 9 requests in loop = 10th request hits 429
    });
  });
});
