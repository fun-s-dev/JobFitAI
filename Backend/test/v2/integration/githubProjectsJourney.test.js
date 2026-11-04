import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestKit, teardownTestKit } from '../../helpers/testKit.js';

/**
 * GitHub projects, end to end through the real routes and models:
 *   confirmed repositories -> draft (projects written from the READMEs) -> verify -> export gate.
 * Only Gemini is faked (embeddings, bullet writing, claim extraction, entailment). All data is synthetic.
 */

const TOPICS = ['node', 'mongo', 'rag', 'python', 'ledger'];
const embed = (text) => [...TOPICS.map((w) => String(text).toLowerCase().split(w).length - 1), 0.001];

const BULLET = 'Built ledger-based transfers with MongoDB sessions.';

describe('GitHub projects: draft -> verify -> export', () => {
  let kit;
  let ReportProjectLink;
  let GithubAnalysis;
  let RepoRanking;
  let InterviewReport;
  let ResumeDraft;
  let controllers;
  let report;
  let analysis;
  let generateCalls;

  const resumeProjectDraft = {
    name: 'Riley Tester',
    contact: [],
    summary: 'x',
    experience: [],
    projects: [{ id: 'prj0', name: 'Resume Only Project', bullets: [{ id: 'prj0.b0', text: 'Built something from the resume.' }] }],
    skills: [],
    education: [],
  };

  function buildRealProjectService(llmOverrides = {}) {
    const { createProjectDraftService } = require('../../../src/v2/services/projectDraft.service');
    return createProjectDraftService({
      llmClient: {
        embedTexts: async (texts) => ({ vectors: texts.map(embed) }),
        generateStructured: vi.fn(async (args) => {
          generateCalls.push(args);
          return { bullets: [{ text: BULLET, evidence: ['E1'] }] };
        }),
        ...llmOverrides,
      },
      RankingModel: RepoRanking,
      LinkModel: ReportProjectLink,
      AnalysisModel: GithubAnalysis,
    });
  }

  async function seedSelection({ verified = true } = {}) {
    analysis = await GithubAnalysis.create({
      repositoryUrl: 'https://github.com/alice-gh/Banking-System-backend',
      repositoryFullName: 'alice-gh/Banking-System-backend',
      commitSha: 'sha1',
      languages: { JavaScript: 1 },
      dependencies: [{ name: 'mongoose', ecosystem: 'npm', skills: ['MongoDB'] }],
      readmeText: 'A Node.js banking backend with a ledger and MongoDB sessions.',
      readmeChecked: true,
      analysisStatus: 'complete',
    });
    await ReportProjectLink.create({
      report: report._id,
      user: kit.userA.id,
      analysisId: analysis._id,
      repoUrl: analysis.repositoryUrl,
      control: verified
        ? { verified: true, method: 'github_app_identity', githubLogin: 'alice-gh' }
        : { verified: false, method: 'pasted_public_url' },
    });
    await RepoRanking.create({
      report: report._id,
      user: kit.userA.id,
      jobDescriptionHash: 'h',
      requirements: [{ text: 'Build Node.js APIs with MongoDB', importance: 'must', keywords: ['Node.js'] }],
      repos: [{ repoId: 1, fullName: 'alice-gh/Banking-System-backend', status: 'ranked', rank: 1, score: 0.5, analysisId: analysis._id }],
      selectedRepoIds: [1],
      selectionConfirmedAt: new Date(),
    });
  }

  const createDraft = (agent = kit.agentA) => agent.post(`/api/v2/drafts/${report._id}`);
  const verify = () => kit.agentA.post(`/api/v2/verification/${report._id}`).send({});
  const groundedInfo = () => kit.agentA.get(`/api/v2/drafts/${report._id}/grounded`);
  const printHtml = () => kit.agentA.get(`/api/v2/drafts/${report._id}/print`);
  const details = (body, agent = kit.agentA, analysisId = analysis._id) =>
    agent.patch(`/api/v2/github/links/${analysisId}/details`).send({ reportId: String(report._id), ...body });

  beforeAll(async () => {
    kit = await setupTestKit();
    ReportProjectLink = require('../../../src/v2/models/reportProjectLink.model');
    GithubAnalysis = require('../../../src/v2/models/githubAnalysis');
    RepoRanking = require('../../../src/v2/models/repoRanking.model');
    InterviewReport = require('../../../src/models/interviewReport.model');
    ResumeDraft = require('../../../src/v2/models/resumeDraft.model');
    controllers = {
      draft: require('../../../src/v2/controllers/draft.controller'),
      verification: require('../../../src/v2/controllers/verification.controller'),
    };
    const { createVerificationService } = require('../../../src/v2/services/verification.service');
    const verificationService = createVerificationService({
      claimExtractionService: {
        extractClaimsFromBullets: async (bullets) => ({
          claims: bullets.map((b) => ({ bulletId: b.id, claimText: b.text, claimType: 'other', skills: [], numbers: [] })),
          incompleteBullets: [],
        }),
      },
      evidenceMatchingService: {
        prepareEvidenceChunks: async (chunks) => ({
          chunksWithVectors: chunks.map((c) => ({ chunk: c, vector: embed(c.text) })),
          stats: {},
        }),
        matchClaim: async (_t, chunksWithVectors) =>
          chunksWithVectors.slice(0, 1).map((it) => ({ chunk: it.chunk, rawCosine: 0.9, similarityScore: 1 })),
      },
      // Mirrors the real service: no evidence means no support
      entailmentService: {
        evaluateClaim: async ({ evidenceChunks }) => {
          const supported = evidenceChunks.length > 0;
          return {
            verdict: supported ? 'yes' : 'no',
            rawVerdict: supported ? 'yes' : 'no',
            entailmentScore: supported ? 1 : 0,
            evidenceQuote: '',
            missingElements: [],
            quoteUngrounded: false,
            caps: [],
          };
        },
      },
    });
    controllers.verification.setVerificationService(verificationService);
    controllers.verification.setVerificationSyncMode(true);
    controllers.draft.setDraftService({ generateDraft: async () => JSON.parse(JSON.stringify(resumeProjectDraft)) });
  });

  afterAll(async () => {
    controllers.draft.setDraftService(null);
    controllers.draft.setProjectDraftService(null);
    controllers.verification.setVerificationService(null);
    controllers.verification.setVerificationSyncMode(false);
    await teardownTestKit();
  });

  beforeEach(async () => {
    generateCalls = [];
    await Promise.all([
      ReportProjectLink.deleteMany({}),
      GithubAnalysis.deleteMany({}),
      RepoRanking.deleteMany({}),
      InterviewReport.deleteMany({}),
      ResumeDraft.deleteMany({}),
      kit.mongoose.connection.collection('verificationruns').deleteMany({}),
      kit.mongoose.connection.collection('resumeclaims').deleteMany({}),
    ]);
    controllers.draft.setProjectDraftService(buildRealProjectService());
    report = await InterviewReport.create({
      user: kit.userA.id,
      title: 'Backend Engineer',
      jobDescription: 'Backend engineer. Node.js and MongoDB.',
      resume: 'Riley Tester. Worked on some projects.',
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('building the draft', () => {
    it('replaces the resume’s projects with projects written from the selected repositories', async () => {
      await seedSelection();
      const res = await createDraft();

      expect(res.status).toBe(201);
      expect(res.body.githubProjects).toMatchObject({ configured: true, error: null, skipped: [] });
      expect(res.body.githubProjects.used).toEqual([{ name: 'Banking System Backend', repo: 'alice-gh/Banking-System-backend' }]);

      const projects = res.body.draft.projects;
      expect(projects).toHaveLength(1);
      expect(projects[0]).toMatchObject({ id: 'prj0', name: 'Banking System Backend', source: 'github', repoFullName: 'alice-gh/Banking-System-backend' });
      expect(projects[0].analysisId).toBe(String(analysis._id));
      expect(projects[0].bullets[0]).toMatchObject({ id: 'prj0.b0', text: BULLET });
      expect(projects[0].bullets[0].sources.length).toBeGreaterThan(0);
      expect(JSON.stringify(res.body.draft)).not.toContain('Resume Only Project');

      // persisted with the extra fields (not stripped by the schema)
      const stored = await ResumeDraft.findOne({ report: report._id }).lean();
      expect(stored.draft.projects[0].source).toBe('github');
      expect(String(stored.draft.projects[0].analysisId)).toBe(String(analysis._id));
      expect(stored.draft.projects[0].bullets[0].sources.length).toBeGreaterThan(0);
    });

    it('keeps the resume’s own projects when no repositories were selected', async () => {
      const res = await createDraft();
      expect(res.status).toBe(201);
      expect(res.body.githubProjects).toMatchObject({ configured: false, used: [], error: null });
      expect(res.body.draft.projects[0].name).toBe('Resume Only Project');
      expect(generateCalls).toHaveLength(0);
    });

    it('never loses the draft if writing GitHub projects fails: the resume projects stay and the error is reported', async () => {
      await seedSelection();
      controllers.draft.setProjectDraftService({ buildGithubProjects: async () => { throw new Error('Gemini is down'); } });
      const res = await createDraft();

      expect(res.status).toBe(201);
      expect(res.body.githubProjects.error).toBe('Gemini is down');
      expect(res.body.draft.projects[0].name).toBe('Resume Only Project');
    });

    it('reports repositories that were skipped and keeps the resume projects when none could be written', async () => {
      await seedSelection();
      controllers.draft.setProjectDraftService(buildRealProjectService({ generateStructured: async () => ({ bullets: [] }) }));
      const res = await createDraft();

      expect(res.status).toBe(201);
      expect(res.body.githubProjects.used).toEqual([]);
      expect(res.body.githubProjects.skipped[0].reason).toMatch(/No bullets supported by the README/);
      expect(res.body.draft.projects[0].name).toBe('Resume Only Project');
    });

    it('does not use another user’s selection', async () => {
      await seedSelection();
      const res = await createDraft(kit.agentB);
      expect(res.status).toBe(404); // the report belongs to user A
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('verification and the export gate', () => {
    beforeEach(async () => {
      await seedSelection();
      await createDraft();
    });

    it('verifies the GitHub project’s bullet against its repository', async () => {
      const res = await verify();
      expect(res.status).toBe(200);
      const claim = res.body.claims.find((c) => c.bulletId === 'prj0.b0');
      expect(claim.status).toBe('verified');
      expect(claim.project).toBe('Banking System Backend');
      // the evidence shown comes from the repository, never from the resume text
      expect(claim.resumeEvidence.length).toBeGreaterThan(0);
      expect(claim.resumeEvidence.every((e) => ['readme', 'metadata', 'dependencies'].includes(e.source))).toBe(true);
      expect(res.body.run.config.githubEvidence.projectMatches).toEqual([
        { analysisId: String(analysis._id), repository: 'alice-gh/Banking-System-backend', project: 'Banking System Backend' },
      ]);
    });

    it('keeps the project out of the export until the user confirms they built it, and says why', async () => {
      await verify();
      const info = (await groundedInfo()).body;
      const item = info.excludedItems.find((i) => i.section === 'projects');
      expect(item.text).toBe('Banking System Backend');
      expect(item.reason).toMatch(/Confirm that you built "Banking System Backend".*does not show that you wrote its code/);

      const html = (await printHtml()).text;
      expect(html).not.toContain('Banking System Backend');
      expect(html).not.toContain(BULLET);
    });

    it('exports it after the confirmation, under the name the user chose', async () => {
      await verify();
      const set = await details({ authorshipConfirmed: true, displayName: 'Backend Ledger' });
      expect(set.status).toBe(200);
      expect(set.body).toMatchObject({ displayName: 'Backend Ledger', authorshipConfirmed: true });

      const info = (await groundedInfo()).body;
      expect(info.excludedItems.find((i) => i.section === 'projects')).toBeUndefined();

      const html = (await printHtml()).text;
      expect(html).toContain('Backend Ledger');
      expect(html).toContain(BULLET);
      expect(html).not.toContain('Banking System Backend'); // the chosen name replaces the default
    });

    it('takes the project out again when the confirmation is withdrawn', async () => {
      await verify();
      await details({ authorshipConfirmed: true });
      expect((await printHtml()).text).toContain(BULLET);
      await details({ authorshipConfirmed: false });
      expect((await printHtml()).text).not.toContain(BULLET);
    });

    it('changing the name does not require verifying again', async () => {
      await verify();
      await details({ authorshipConfirmed: true });
      await details({ displayName: 'Ledger Service' });
      const html = (await printHtml()).text;
      expect(html).toContain('Ledger Service');
      expect(html).toContain(BULLET);
    });

    it('a project whose repository is no longer a verified link cannot be verified (no fallback to the resume)', async () => {
      await ReportProjectLink.updateOne({ analysisId: analysis._id }, { $set: { 'control.verified': false } });
      const res = await verify();
      const claim = res.body.claims.find((c) => c.bulletId === 'prj0.b0');
      expect(claim.status).toBe('rejected');
      expect(claim.resumeEvidence).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('project details endpoint', () => {
    beforeEach(async () => {
      await seedSelection();
    });

    it('requires login, and another user gets 404 and changes nothing', async () => {
      expect((await request(kit.app).patch(`/api/v2/github/links/${analysis._id}/details`).send({ reportId: String(report._id), authorshipConfirmed: true })).status).toBe(401);
      expect((await details({ authorshipConfirmed: true }, kit.agentB)).status).toBe(404);
      expect((await ReportProjectLink.findOne({ analysisId: analysis._id }).lean()).authorshipConfirmedAt).toBeNull();
    });

    it('validates strictly: needs a field, rejects extras and bad types', async () => {
      expect((await details({})).status).toBe(400);
      expect((await details({ authorshipConfirmed: 'yes' })).status).toBe(400);
      expect((await details({ authorshipConfirmed: true, control: { verified: true } })).status).toBe(400);
      expect((await details({ displayName: 'x'.repeat(201) })).status).toBe(400);
    });

    it('rejects an empty name, cleans a messy one, and resets with null', async () => {
      const empty = await details({ displayName: '   ' });
      expect(empty.status).toBe(400);
      expect(empty.body.error.code).toBe('INVALID_NAME');

      const messy = await details({ displayName: '  Backend\n\n  Ledger  ' });
      expect(messy.body.displayName).toBe('Backend Ledger');

      const reset = await details({ displayName: null });
      expect(reset.body.displayName).toBeNull();
    });

    it('only works for repositories linked through GitHub Connect', async () => {
      await ReportProjectLink.updateOne({ analysisId: analysis._id }, { $set: { 'control.verified': false } });
      const res = await details({ authorshipConfirmed: true });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NOT_VERIFIED');
    });

    it('keeps the original confirmation time when confirmed twice', async () => {
      await details({ authorshipConfirmed: true });
      const first = (await ReportProjectLink.findOne({ analysisId: analysis._id }).lean()).authorshipConfirmedAt;
      await new Promise((r) => setTimeout(r, 15));
      await details({ authorshipConfirmed: true });
      const second = (await ReportProjectLink.findOne({ analysisId: analysis._id }).lean()).authorshipConfirmedAt;
      expect(second.getTime()).toBe(first.getTime());
    });

    it('the linked repositories list shows what the UI needs for each GitHub project', async () => {
      await details({ displayName: 'Backend Ledger' });
      const res = await kit.agentA.get(`/api/v2/github/links/${report._id}`);
      expect(res.status).toBe(200);
      expect(res.body.links[0]).toMatchObject({
        selected: true,
        displayName: 'Backend Ledger',
        defaultName: 'Banking System Backend',
        authorshipConfirmed: false,
      });
    });
  });
});
