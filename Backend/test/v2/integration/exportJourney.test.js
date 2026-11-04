import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestKit, teardownTestKit } from '../../helpers/testKit.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');
const InterviewReport = require('../../../src/models/interviewReport.model');
const { setDraftService } = require('../../../src/v2/controllers/draft.controller');
const {
  setVerificationService,
  setVerificationSyncMode,
} = require('../../../src/v2/controllers/verification.controller');
const { createVerificationService } = require('../../../src/v2/services/verification.service');
const pdfRenderer = require('../../../src/v2/adapters/pdfRenderer');

/**
 * End-to-end export journey through the real HTTP routes, with every AI call faked:
 * draft -> verify (sync) -> approve a claim -> grounded breakdown -> print HTML -> PDF,
 * then a newer draft is generated and the export must stay bound to the verified draft.
 * All data is synthetic.
 */
describe('V2 export journey (draft -> verify -> approve -> print/pdf)', () => {
  let kit;
  let report;

  const RESUME = [
    'Riley Tester',
    'riley@example.com | Springfield',
    'Software Engineer, Sample Systems, 2022 - 2024',
    '- Built an order API using Node.js and MongoDB.',
    '- Helped onboard new teammates.',
    'BSc Computer Science, Sample University',
  ].join('\n');

  const firstDraft = {
    name: 'Riley Tester',
    contact: ['riley@example.com', 'github.com/riley-invented-profile'],
    summary: 'Award-winning engineer who transformed the company.',
    experience: [
      {
        id: 'exp0',
        company: 'Sample Systems',
        role: 'Software Engineer',
        dates: '2022 - 2024',
        bullets: [
          { id: 'exp0.b0', text: 'Built an order API with Node.js and MongoDB.' },
          { id: 'exp0.b1', text: 'Reduced API latency by 70% for 2M users.' },
          { id: 'exp0.b2', text: 'Mentored new teammates during onboarding.' },
        ],
      },
    ],
    projects: [],
    skills: ['Node.js', 'MongoDB', 'Kubernetes'],
    education: [{ id: 'edu0', school: 'Sample University', degree: 'BSc Computer Science', dates: '' }],
  };

  // Same positional IDs, different (unverified) text: must never be exported with old claims
  const secondDraft = {
    ...firstDraft,
    experience: [
      {
        ...firstDraft.experience[0],
        bullets: [
          { id: 'exp0.b0', text: 'Invented bullet that was never verified.' },
          { id: 'exp0.b1', text: 'Another invented bullet.' },
          { id: 'exp0.b2', text: 'Third invented bullet.' },
        ],
      },
    ],
  };

  const draftQueue = [];
  const fakeDraftService = {
    generateDraft: vi.fn(async () => draftQueue.shift()),
  };

  const fakeVerificationService = createVerificationService({
    claimExtractionService: {
      extractClaimsFromBullets: async (bullets) => ({
        claims: bullets.map((b) => ({
          bulletId: b.id,
          claimText: b.text,
          claimType: 'other',
          skills: [],
          numbers: [],
        })),
        incompleteBullets: [],
      }),
    },
    evidenceMatchingService: {
      prepareEvidenceChunks: async (chunks) => ({
        chunksWithVectors: chunks.map((c) => ({ chunk: c, vector: [0.1, 0.2, 0.3] })),
        stats: { hits: 0, misses: 0, apiCalls: 0 },
      }),
      matchClaim: async (_text, chunksWithVectors) => [
        { chunk: chunksWithVectors[0].chunk, rawCosine: 0.85, similarityScore: 0.875 },
      ],
    },
    entailmentService: {
      evaluateClaim: async ({ claim }) => {
        const verdicts = {
          'exp0.b0': { verdict: 'yes', entailmentScore: 1.0 },
          'exp0.b1': { verdict: 'no', entailmentScore: 0.0 },
          'exp0.b2': { verdict: 'partial', entailmentScore: 0.5 },
        };
        const v = verdicts[claim.bulletId] || { verdict: 'no', entailmentScore: 0 };
        return {
          ...v,
          rawVerdict: v.verdict,
          evidenceQuote: '',
          missingElements: [],
          quoteUngrounded: false,
          caps: [],
        };
      },
    },
  });

  let runId;
  let claims;

  beforeAll(async () => {
    kit = await setupTestKit();
    setDraftService(fakeDraftService);
    setVerificationService(fakeVerificationService);
    setVerificationSyncMode(true);

    report = await InterviewReport.create({
      user: kit.userA.id,
      title: 'Software Engineer',
      jobDescription: 'Backend engineer with Node.js and Kubernetes.',
      resume: RESUME,
      selfDescription: '',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    setDraftService(null);
    setVerificationService(null);
    setVerificationSyncMode(false);
    await teardownTestKit();
  });

  it('1. generates a draft that keeps the name and contact header fields', async () => {
    draftQueue.push(firstDraft);
    const res = await kit.agentA.post(`/api/v2/drafts/${report._id}`);
    expect(res.status).toBe(201);
    expect(res.body.draft.name).toBe('Riley Tester');
    expect(res.body.draft.contact).toEqual(firstDraft.contact);
  });

  it('2. reports nothing verified yet before verification runs', async () => {
    const res = await kit.agentA.get(`/api/v2/drafts/${report._id}/grounded`);
    expect(res.status).toBe(200);
    expect(res.body.runId).toBeNull();
    expect(res.body.isLatestDraftVerified).toBeNull();
    expect(res.body.allowedBulletIds).toEqual([]);
  });

  it('3. runs verification and stores one claim per bullet with the expected statuses', async () => {
    const res = await kit.agentA.post(`/api/v2/verification/${report._id}`).send({});
    expect(res.status).toBe(200);
    runId = res.body.run._id;
    claims = res.body.claims;

    const byBullet = Object.fromEntries(claims.map((c) => [c.bulletId, c.status]));
    expect(byBullet).toEqual({ 'exp0.b0': 'verified', 'exp0.b1': 'rejected', 'exp0.b2': 'needs_review' });
  });

  it('4. lets the owner approve the needs_review claim', async () => {
    const claim = claims.find((c) => c.bulletId === 'exp0.b2');
    const res = await kit.agentA
      .patch(`/api/v2/verification/claim/${claim._id}`)
      .send({ decision: 'approved' });
    expect(res.status).toBe(200);
    expect(res.body.effectiveStatus).toBe('approved');
  });

  it('5. grounded breakdown lists excluded bullets and excluded non-bullet items', async () => {
    const res = await kit.agentA.get(`/api/v2/drafts/${report._id}/grounded`);
    expect(res.status).toBe(200);
    expect(String(res.body.runId)).toBe(String(runId));
    expect(res.body.isLatestDraftVerified).toBe(true);
    expect(res.body.allowedBulletIds.sort()).toEqual(['exp0.b0', 'exp0.b2']);
    expect(res.body.excludedBulletIds).toEqual(['exp0.b1']);

    const items = res.body.excludedItems.map((i) => `${i.section}:${i.text}`);
    expect(items).toContain('summary:Award-winning engineer who transformed the company.');
    expect(items).toContain('skills:Kubernetes');
    expect(items).toContain('header:github.com/riley-invented-profile');
  });

  it('6. print view contains exactly the grounded content under a no-script CSP', async () => {
    const res = await kit.agentA.get(`/api/v2/drafts/${report._id}/print`);
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toContain("script-src 'none'");
    expect(res.headers['cache-control']).toBe('no-store');

    const html = res.text;
    expect(html).toContain('Riley Tester');
    expect(html).toContain('riley@example.com');
    expect(html).toContain('Built an order API with Node.js and MongoDB.');
    expect(html).toContain('Mentored new teammates during onboarding.'); // approved by user
    expect(html).toContain('BSc Computer Science');
    expect(html).toContain('Node.js');

    expect(html).not.toContain('Reduced API latency by 70%'); // rejected
    expect(html).not.toContain('Award-winning'); // summary not claim-checked
    expect(html).not.toContain('Kubernetes'); // skill not in resume
    expect(html).not.toContain('riley-invented-profile'); // contact not in resume
  });

  it('7. server PDF contains the same grounded content', async () => {
    const res = await kit.agentA
      .post(`/api/v2/drafts/${report._id}/pdf`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .send({});
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');

    const text = (await new PDFParse({ data: res.body }).getText()).text;
    expect(text).toContain('Riley Tester');
    expect(text).toContain('order API');
    expect(text).not.toContain('70%');
    expect(text).not.toContain('Kubernetes');
    expect(text).not.toContain('Award-winning');
  }, 30000);

  it('8. returns a clear 503 when Chromium cannot launch', async () => {
    vi.spyOn(pdfRenderer, 'renderDraftToPdf').mockRejectedValueOnce(
      new pdfRenderer.PdfRendererUnavailableError('Chromium failed to launch')
    );
    const res = await kit.agentA.post(`/api/v2/drafts/${report._id}/pdf`).send({});
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('PDF_RENDERER_UNAVAILABLE');
    expect(res.body.error.message).toMatch(/Print \/ Save as PDF/);
  });

  it('9. stays bound to the verified draft after a newer draft is generated', async () => {
    draftQueue.push(secondDraft);
    const created = await kit.agentA.post(`/api/v2/drafts/${report._id}`);
    expect(created.status).toBe(201);
    expect(created.body.version).toBe(2);

    const grounded = await kit.agentA.get(`/api/v2/drafts/${report._id}/grounded`);
    expect(grounded.body.isLatestDraftVerified).toBe(false);
    expect(String(grounded.body.latestDraftId)).toBe(String(created.body.draftId));

    const print = await kit.agentA.get(`/api/v2/drafts/${report._id}/print`);
    expect(print.status).toBe(200);
    expect(print.text).toContain('Built an order API with Node.js and MongoDB.');
    expect(print.text).not.toContain('Invented bullet that was never verified.');
    expect(print.text).not.toContain('Third invented bullet.');
  });

  it('10. rejects unknown runIds, non-owners and anonymous users', async () => {
    const unknownRun = await kit.agentA.get(
      `/api/v2/drafts/${report._id}/print?runId=000000000000000000000000`
    );
    expect(unknownRun.status).toBe(404);
    expect(unknownRun.body.error.code).toBe('RUN_NOT_FOUND');

    const otherUser = await kit.agentB.get(`/api/v2/drafts/${report._id}/print`);
    expect(otherUser.status).toBe(404);

    const otherUserPdf = await kit.agentB.post(`/api/v2/drafts/${report._id}/pdf`).send({});
    expect(otherUserPdf.status).toBe(404);

    const anonymous = await request(kit.app).get(`/api/v2/drafts/${report._id}/print`);
    expect(anonymous.status).toBe(401);
  });
});
