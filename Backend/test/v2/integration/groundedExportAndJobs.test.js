import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestKit, teardownTestKit } from '../../helpers/testKit.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');
const InterviewReport = require('../../../src/models/interviewReport.model');
const ResumeDraft = require('../../../src/v2/models/resumeDraft.model');
const VerificationRun = require('../../../src/v2/models/verificationRun.model');
const ResumeClaim = require('../../../src/v2/models/resumeClaim.model');
const Job = require('../../../src/v2/models/job');
const { cleanupInterruptedJobs } = require('../../../src/v2/services/jobRunner');

describe('v2 Grounded Export & Background Jobs Integration Tests', () => {
  let kit;
  let reportA;
  let _reportB;
  let draftA;
  let runA;

  const sampleDraft = {
    summary: 'Lead engineer with expertise in distributed architectures.',
    experience: [
      {
        id: 'exp0',
        company: 'Stripe',
        role: 'Senior Backend Engineer',
        dates: '2021 - Present',
        bullets: [
          {
            id: 'exp0.b0',
            text: 'Engineered high-throughput payments worker processing 15M transactions daily.',
          },
          {
            id: 'exp0.b1',
            text: 'Reduced checkout database latency by 99% using quantum caching algorithms.',
          },
          {
            id: 'exp0.b2',
            text: 'Malicious payload <script>alert("xss")</script> and database sync.',
          },
        ],
      },
    ],
    projects: [
      {
        id: 'prj0',
        name: 'JobFitAI',
        bullets: [
          {
            id: 'prj0.b0',
            text: 'Built deterministic ground-truth verification engine.',
          },
        ],
      },
    ],
    skills: ['Node.js', 'Express', 'Redis', 'MongoDB'],
    education: [
      {
        id: 'edu0',
        school: 'MIT',
        degree: 'B.S. CS',
        dates: '2016 - 2020',
      },
    ],
  };

  beforeAll(async () => {
    kit = await setupTestKit();
  });

  afterAll(async () => {
    await teardownTestKit();
  });

  beforeEach(async () => {
    await InterviewReport.deleteMany({});
    await ResumeDraft.deleteMany({});
    await VerificationRun.deleteMany({});
    await ResumeClaim.deleteMany({});
    await Job.deleteMany({});

    const userAId = kit.userA._id || kit.userA.id;
    const userBId = kit.userB._id || kit.userB.id;

    reportA = await InterviewReport.create({
      user: userAId,
      title: 'Senior Backend Engineer',
      jobDescription: 'Senior Backend Engineer at Stripe',
      resume: 'Experienced backend developer at Stripe building payment pipelines.',
      selfDescription: 'I led backend payment workers.',
      matchScore: 88,
      status: 'completed',
    });

    _reportB = await InterviewReport.create({
      user: userBId,
      title: 'Frontend Engineer',
      jobDescription: 'Frontend Engineer',
      resume: 'React engineer.',
      matchScore: 75,
      status: 'completed',
    });

    draftA = await ResumeDraft.create({
      report: reportA._id,
      user: userAId,
      draft: sampleDraft,
      version: 1,
    });

    runA = await VerificationRun.create({
      report: reportA._id,
      user: userAId,
      draft: draftA._id,
      status: 'completed',
      summary: { total: 4, verified: 2, needsReview: 1, rejected: 1 },
      config: {
        weights: { W_SIM: 0.3, W_ENT: 0.4, W_PROJ: 0.3 },
        thresholds: { verified: 0.8, review: 0.5 },
      },
    });

    // Create claims:
    // exp0.b0: verified -> KEEP
    await ResumeClaim.create({
      run: runA._id,
      report: reportA._id,
      user: userAId,
      bulletId: 'exp0.b0',
      claimText: '15M transactions daily',
      confidenceScore: 0.92,
      status: 'verified',
      entailment: { verdict: 'yes', score: 1.0 },
      provenance: { generationModel: 'gemini-3.5-flash-lite' },
    });

    // exp0.b1: rejected -> DROP
    await ResumeClaim.create({
      run: runA._id,
      report: reportA._id,
      user: userAId,
      bulletId: 'exp0.b1',
      claimText: 'Reduced checkout database latency by 99% using quantum caching',
      confidenceScore: 0.15,
      status: 'rejected',
      entailment: { verdict: 'no', score: 0.0 },
      provenance: { generationModel: 'gemini-3.5-flash-lite' },
    });

    // exp0.b2: verified with <script> tag -> KEEP (must be HTML-escaped)
    await ResumeClaim.create({
      run: runA._id,
      report: reportA._id,
      user: userAId,
      bulletId: 'exp0.b2',
      claimText: 'Database sync',
      confidenceScore: 0.88,
      status: 'verified',
      entailment: { verdict: 'yes', score: 1.0 },
      provenance: { generationModel: 'gemini-3.5-flash-lite' },
    });

    // prj0.b0: needs_review -> DROP (no user override)
    await ResumeClaim.create({
      run: runA._id,
      report: reportA._id,
      user: userAId,
      bulletId: 'prj0.b0',
      claimText: 'Deterministic ground-truth',
      confidenceScore: 0.65,
      status: 'needs_review',
      entailment: { verdict: 'partial', score: 0.5 },
      provenance: { generationModel: 'gemini-3.5-flash-lite' },
    });
  });

  describe('Background Jobs API & Lifecycle', () => {
    it('POST /api/v2/verification/:reportId returns 202 { jobId, status: "queued" } by default', async () => {
      const res = await kit.agentA
        .post(`/api/v2/verification/${reportA._id}`)
        .send({});

      expect(res.status).toBe(202);
      expect(res.body.jobId).toBeDefined();
      expect(res.body.status).toBe('queued');

      const userAId = kit.userA._id || kit.userA.id;
      const jobInDb = await Job.findById(res.body.jobId);
      expect(jobInDb).not.toBeNull();
      expect(String(jobInDb.user)).toBe(String(userAId));
      expect(String(jobInDb.report)).toBe(String(reportA._id));
    });

    it('duplicate POST returns the existing active job (idempotent double-click defense)', async () => {
      const res1 = await kit.agentA
        .post(`/api/v2/verification/${reportA._id}`)
        .send({});
      expect(res1.status).toBe(202);
      const firstJobId = res1.body.jobId;

      const res2 = await kit.agentA
        .post(`/api/v2/verification/${reportA._id}`)
        .send({});
      expect(res2.status).toBe(202);
      expect(res2.body.jobId).toBe(firstJobId);
    });

    it('GET /api/v2/jobs/:id returns 200 for owner and 404 for non-owner (IDOR defense)', async () => {
      const resJob = await kit.agentA
        .post(`/api/v2/verification/${reportA._id}`)
        .send({});
      const jobId = resJob.body.jobId;

      // Owner (User A) -> 200
      const resOwner = await kit.agentA.get(`/api/v2/jobs/${jobId}`);
      expect(resOwner.status).toBe(200);
      expect(resOwner.body.job._id).toBe(jobId);
      expect(resOwner.body.job.status).toBeDefined();

      // Non-owner (User B) -> 404
      const resOther = await kit.agentB.get(`/api/v2/jobs/${jobId}`);
      expect(resOther.status).toBe(404);
      expect(resOther.body.error.code).toBe('NOT_FOUND');

      // Non-existent job -> 404
      const nonExistent = '000000000000000000000000';
      const res404 = await kit.agentA.get(`/api/v2/jobs/${nonExistent}`);
      expect(res404.status).toBe(404);
    });

    it('cleanupInterruptedJobs marks running jobs as failed with INTERRUPTED on server restart', async () => {
      const userAId = kit.userA._id || kit.userA.id;
      // Create a stuck 'running' job
      const stuckJob = await Job.create({
        user: userAId,
        report: reportA._id,
        type: 'verification',
        status: 'running',
        startedAt: new Date(Date.now() - 60000),
      });

      await cleanupInterruptedJobs();

      const refreshed = await Job.findById(stuckJob._id);
      expect(refreshed.status).toBe('failed');
      expect(refreshed.error.code).toBe('INTERRUPTED');
      expect(refreshed.error.message).toMatch(/interrupted/i);
      expect(refreshed.finishedAt).toBeInstanceOf(Date);
    });
  });

  describe('Grounded Print HTML Export (GET /api/v2/drafts/:reportId/print)', () => {
    it('returns 404 when requested by an unauthorized user (ownership check)', async () => {
      const res = await kit.agentB.get(`/api/v2/drafts/${reportA._id}/print`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns strict CSP header and text/html content type', async () => {
      const res = await kit.agentA.get(`/api/v2/drafts/${reportA._id}/print?runId=${runA._id}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);

      const csp = res.headers['content-security-policy'];
      expect(csp).toBeDefined();
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'none'");
      expect(csp).toContain("img-src 'none'");
    });

    it('omits rejected bullet text from HTML and keeps verified bullet text', async () => {
      const res = await kit.agentA.get(`/api/v2/drafts/${reportA._id}/print?runId=${runA._id}`);
      expect(res.status).toBe(200);
      const html = res.text;

      // Verified bullet must be present
      expect(html).toContain('Engineered high-throughput payments worker processing 15M transactions daily.');

      // Rejected bullet must be absent
      expect(html).not.toContain('Reduced checkout database latency by 99% using quantum caching algorithms.');

      // Needs_review bullet (prj0.b0) without override must be absent
      expect(html).not.toContain('Built deterministic ground-truth verification engine.');
    });

    it('escapes script tags in bullet text to prevent XSS / script injection', async () => {
      const res = await kit.agentA.get(`/api/v2/drafts/${reportA._id}/print?runId=${runA._id}`);
      expect(res.status).toBe(200);
      const html = res.text;

      // Raw <script> tag must NOT be present
      expect(html).not.toContain('<script>alert("xss")</script>');

      // Escaped HTML entities must be present
      expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    });
  });

  describe('Grounded PDF Export (POST /api/v2/drafts/:reportId/pdf)', () => {
    it('returns 404 when report is not owned by user', async () => {
      const res = await kit.agentB
        .post(`/api/v2/drafts/${reportA._id}/pdf`)
        .send({ runId: runA._id });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('renders grounded PDF buffer and omits rejected bullet text (asserted via pdf-parse)', async () => {
      const res = await kit.agentA
        .post(`/api/v2/drafts/${reportA._id}/pdf`)
        .send({ runId: runA._id });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');

      const parser = new PDFParse({ data: res.body });
      const parsedPdf = await parser.getText();
      const pdfText = parsedPdf.text;

      // Verified bullet must be in PDF
      expect(pdfText).toContain('15M transactions daily');

      // Rejected bullet must NOT be in PDF
      expect(pdfText).not.toContain('quantum caching algorithms');

      // Unapproved needs_review bullet must NOT be in PDF
      expect(pdfText).not.toContain('deterministic ground-truth');
    }, 25000); // 25s timeout for Puppeteer PDF rendering
  });

  describe('Grounded Breakdown Metadata (GET /api/v2/drafts/:reportId/grounded)', () => {
    it('returns 200 with allowed and excluded bullets plus reasons for UI', async () => {
      const res = await kit.agentA.get(`/api/v2/drafts/${reportA._id}/grounded?runId=${runA._id}`);

      expect(res.status).toBe(200);
      expect(res.body.allowedBulletIds).toContain('exp0.b0');
      expect(res.body.allowedBulletIds).toContain('exp0.b2');
      expect(res.body.excludedBulletIds).toContain('exp0.b1');
      expect(res.body.excludedBulletIds).toContain('prj0.b0');

      expect(res.body.excludedBullets).toHaveLength(2);
      const exp0b1 = res.body.excludedBullets.find((b) => b.bulletId === 'exp0.b1');
      expect(exp0b1).toBeDefined();
      expect(exp0b1.reasons[0]).toMatch(/rejected/);
    });
  });
});
