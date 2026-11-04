import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestKit, teardownTestKit } from '../../helpers/testKit.js';

/**
 * Repository ranking: routes, middleware, validation, models, the job runner and the ranking service
 * run for real. Only the two external boundaries are faked:
 *   - GitHub (connect service + repository analysis)
 *   - Gemini (requirement extraction + embeddings; a deterministic topic-count embedding)
 */

const TOPICS = ['node', 'express', 'mongo', 'react', 'python', 'fastapi', 'rag', 'embedding', 'docker'];

/** Deterministic embedding: how often each topic word occurs, plus a tiny constant so no vector is zero. */
function embedText(text) {
  const t = String(text).toLowerCase();
  return [...TOPICS.map((w) => (t.split(w).length - 1)), 0.001];
}

const REQUIREMENTS = [
  { text: 'Build REST APIs with Node.js and MongoDB', importance: 'must', keywords: ['Node.js', 'MongoDB'] },
  { text: 'Experience with RAG and embeddings', importance: 'nice', keywords: ['RAG'] },
];

describe('repository ranking (routes + job + service)', () => {
  let kit;
  let Job;
  let InterviewReport;
  let ReportProjectLink;
  let GithubAnalysis;
  let RepoRanking;
  let LlmCall;
  let reportA;
  let api;

  let evidenceCalls;
  let requirementCalls;
  let embedCalls;
  let gate;
  let connectState;

  const repoRow = (repoId, name, extra = {}) => ({
    repoId,
    name,
    fullName: `alice-gh/${name}`,
    htmlUrl: `https://github.com/alice-gh/${name}`,
    description: null,
    language: 'JavaScript',
    pushedAt: new Date(2025, 0, repoId).toISOString(),
    selectable: true,
    ...extra,
  });

  const README = {
    'node-api': 'A REST API built with Node.js and MongoDB.',
    'rag-bot': 'A RAG assistant with embeddings.',
    'react-todo': 'A small React todo app.',
  };

  function buildApi() {
    const { createRepoRankingService } = require('../../../src/v2/services/repoRanking.service');
    const { buildLinkUpdate } = require('../../../src/v2/services/githubEvidence.service');

    const connectService = {
      isConfigured: () => true,
      getStatus: async () => ({ configured: true, connected: connectState.connected, login: 'alice-gh' }),
      listRepositories: async () => ({ login: 'alice-gh', repos: connectState.repos }),
      getClientForUser: async () => ({ fake: 'client' }),
      resolveRepository: async (_userId, repoId) => {
        const repo = connectState.repos.find((r) => r.repoId === repoId);
        const owned = connectState.ownedIds.has(repoId);
        return {
          repo: owned ? { selectable: true } : { selectable: false, unsupportedMessage: 'This repository is not owned by your connected GitHub account.' },
          control: owned
            ? { verified: true, method: 'github_app_identity', githubUserId: 1001, githubLogin: 'alice-gh', repoId: repo.repoId, verifiedAt: new Date() }
            : null,
        };
      },
    };

    const githubEvidenceService = {
      analyzeRepository: vi.fn(async (args) => {
        evidenceCalls.push(args);
        if (gate) await gate;
        const name = args.repoUrl.split('/').pop();
        if (name === 'broken') throw new Error('GitHub rate limit reached');
        const readmeText = name === 'no-readme' ? null : README[name] || `${name} readme`;
        const analysis = await GithubAnalysis.findOneAndUpdate(
          { repositoryFullName: `alice-gh/${name}`, commitSha: 'sha1' },
          {
            $set: {
              repositoryUrl: args.repoUrl,
              repositoryFullName: `alice-gh/${name}`,
              commitSha: 'sha1',
              description: null,
              languages: { JavaScript: 100 },
              dependencies: name === 'node-api' ? [{ name: 'express', ecosystem: 'npm', skills: ['Express'] }] : [],
              readmeText,
              readmeChecked: true,
              analysisStatus: 'complete',
            },
          },
          { upsert: true, returnDocument: 'after' }
        );
        return { analysis, cached: false };
      }),
    };

    const llmClient = {
      embedTexts: vi.fn(async (texts) => {
        embedCalls.push(texts);
        return { vectors: texts.map(embedText), stats: {} };
      }),
    };

    const requirementsService = {
      extractRequirements: vi.fn(async () => {
        requirementCalls.push(1);
        return REQUIREMENTS.map((r) => ({ ...r }));
      }),
    };

    const service = createRepoRankingService({
      connectService,
      githubEvidenceService,
      llmClient,
      requirementsService,
      RankingModel: RepoRanking,
      ReportModel: InterviewReport,
      LinkModel: ReportProjectLink,
      buildLinkUpdate,
      cfg: { RANKING_MAX_REPOS: 15, RANKING_TOP_N: 2 },
    });
    return { connectService, service };
  }

  async function waitForJob(status = 'done') {
    let job;
    await vi.waitFor(async () => {
      job = await Job.findOne({ report: reportA._id, type: 'repo_ranking' }).sort({ createdAt: -1 }).lean();
      expect(job && job.status).toBe(status);
    });
    return job;
  }

  const startRanking = (agent = kit.agentA, reportId = reportA._id) => agent.post(`/api/v2/github/ranking/${reportId}`).send({});
  const getRanking = (agent = kit.agentA, reportId = reportA._id) => agent.get(`/api/v2/github/ranking/${reportId}`);
  const putSelection = (body, agent = kit.agentA, reportId = reportA._id) =>
    agent.put(`/api/v2/github/ranking/${reportId}/selection`).send(body);

  beforeAll(async () => {
    process.env.RATE_LIMIT_GITHUB_MAX = '1000';
    process.env.RATE_LIMIT_GITHUB_CONNECT_MAX = '1000';
    kit = await setupTestKit();
    Job = require('../../../src/v2/models/job');
    InterviewReport = require('../../../src/models/interviewReport.model');
    ReportProjectLink = require('../../../src/v2/models/reportProjectLink.model');
    GithubAnalysis = require('../../../src/v2/models/githubAnalysis');
    RepoRanking = require('../../../src/v2/models/repoRanking.model');
    LlmCall = require('../../../src/v2/models/llmCall.model');
    api = require('../../../src/v2/controllers/github.controller');
  });

  afterAll(async () => {
    api.setGithubConnectService(null);
    api.setRepoRankingService(null);
    for (const k of ['RATE_LIMIT_GITHUB_MAX', 'RATE_LIMIT_GITHUB_CONNECT_MAX', 'USER_DAILY_RANKINGS', 'LLM_DAILY_BUDGET', 'EMBEDDING_DAILY_BUDGET']) {
      delete process.env[k];
    }
    await teardownTestKit();
  });

  beforeEach(async () => {
    evidenceCalls = [];
    requirementCalls = [];
    embedCalls = [];
    gate = null;
    connectState = {
      connected: true,
      ownedIds: new Set([1, 2, 3]),
      repos: [
        repoRow(1, 'node-api'),
        repoRow(2, 'rag-bot'),
        repoRow(3, 'react-todo'),
        repoRow(4, 'no-readme'),
        repoRow(5, 'broken'),
        repoRow(6, 'forked', { selectable: false }),
      ],
    };
    const { connectService, service } = buildApi();
    api.setGithubConnectService(connectService);
    api.setRepoRankingService(service);

    await Promise.all([
      Job.deleteMany({}),
      InterviewReport.deleteMany({}),
      ReportProjectLink.deleteMany({}),
      GithubAnalysis.deleteMany({}),
      RepoRanking.deleteMany({}),
      LlmCall.deleteMany({}),
    ]);
    delete process.env.USER_DAILY_RANKINGS;
    delete process.env.LLM_DAILY_BUDGET;
    delete process.env.EMBEDDING_DAILY_BUDGET;

    reportA = await InterviewReport.create({
      user: kit.userA.id,
      title: 'Backend Engineer',
      jobDescription: 'Backend engineer. Node.js and MongoDB REST APIs. Nice to have: RAG.',
      resume: 'Built REST APIs.',
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('access control and preconditions', () => {
    it('requires login on all three routes', async () => {
      expect((await request(kit.app).post(`/api/v2/github/ranking/${reportA._id}`).send({})).status).toBe(401);
      expect((await request(kit.app).get(`/api/v2/github/ranking/${reportA._id}`)).status).toBe(401);
      expect((await request(kit.app).put(`/api/v2/github/ranking/${reportA._id}/selection`).send({ repoIds: [1] })).status).toBe(401);
    });

    it('another user gets 404 on every route and starts nothing', async () => {
      expect((await startRanking(kit.agentB)).status).toBe(404);
      expect((await getRanking(kit.agentB)).status).toBe(404);
      expect((await putSelection({ repoIds: [1] }, kit.agentB)).status).toBe(404);
      expect(await Job.countDocuments()).toBe(0);
    });

    it('rejects an invalid report id', async () => {
      expect((await kit.agentA.post('/api/v2/github/ranking/not-an-id').send({})).status).toBe(400);
    });

    it('asks the user to connect GitHub first and creates no job', async () => {
      connectState.connected = false;
      const res = await startRanking();
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('GITHUB_NOT_CONNECTED');
      expect(await Job.countDocuments()).toBe(0);
    });

    it('returns null before any ranking exists', async () => {
      const res = await getRanking();
      expect(res.status).toBe(200);
      expect(res.body.ranking).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('ranking the repositories', () => {
    it('ranks eligible repositories against the job, pre-selects the top ones and explains each match', async () => {
      const res = await startRanking();
      expect(res.status).toBe(202);
      await waitForJob('done');

      const body = (await getRanking()).body;
      const { ranking } = body;
      expect(ranking.requirements.map((r) => r.text)).toEqual(REQUIREMENTS.map((r) => r.text));

      const ranked = ranking.repos.filter((r) => r.status === 'ranked');
      expect(ranked.map((r) => r.fullName)).toEqual(['alice-gh/node-api', 'alice-gh/rag-bot', 'alice-gh/react-todo']);
      expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
      expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
      expect(ranked[1].score).toBeGreaterThan(ranked[2].score);

      // The reason is the actual text that matched
      expect(ranked[0].matched[0]).toMatchObject({ importance: 'must', source: expect.any(String) });
      expect(ranked[0].matched[0].snippet.toLowerCase()).toContain('node.js');
      expect(ranked[1].matched.some((m) => m.requirement.includes('RAG'))).toBe(true);

      // Top N (configured as 2 in this test) are pre-selected but not yet confirmed
      expect(ranking.selectedRepoIds).toEqual([1, 2]);
      expect(ranking.selectionConfirmedAt).toBeNull();
      expect(body.topN).toBeGreaterThan(0);
    });

    it('skips a repository without a README and says so; a failing repository is skipped with a reason', async () => {
      await startRanking();
      await waitForJob('done');
      const { ranking } = (await getRanking()).body;

      const noReadme = ranking.repos.find((r) => r.fullName === 'alice-gh/no-readme');
      expect(noReadme).toMatchObject({ status: 'skipped_no_readme', rank: null, score: null });
      expect(noReadme.skipReason).toBe('alice-gh/no-readme has no README, so it was skipped.');

      const broken = ranking.repos.find((r) => r.fullName === 'alice-gh/broken');
      expect(broken.status).toBe('skipped_error');
      expect(broken.skipReason).toMatch(/alice-gh\/broken could not be analysed/);
      expect(broken.skipReason).toMatch(/rate limit/i);
    });

    it('only analyses eligible repositories and never links candidates to the report', async () => {
      await startRanking();
      await waitForJob('done');

      const analysed = evidenceCalls.map((c) => c.repoUrl.split('/').pop()).sort();
      expect(analysed).toEqual(['broken', 'no-readme', 'node-api', 'rag-bot', 'react-todo']); // not the fork
      expect(evidenceCalls.every((c) => c.reportId === undefined && c.control === null)).toBe(true);
      expect(await ReportProjectLink.countDocuments({ report: reportA._id })).toBe(0);
    });

    it('embeds requirements and all repository chunks in a single batch', async () => {
      await startRanking();
      await waitForJob('done');
      expect(embedCalls).toHaveLength(1);
      expect(embedCalls[0][0]).toBe(REQUIREMENTS[0].text);
      expect(embedCalls[0].length).toBeGreaterThan(REQUIREMENTS.length);
    });

    it('records progress as repositories are analysed', async () => {
      await startRanking();
      const job = await waitForJob('done');
      expect(job.progress).toEqual({ done: 5, total: 5 });
    });

    it('reuses the extracted requirements while the job description is unchanged, and extracts again when it changes', async () => {
      await startRanking();
      await waitForJob('done');
      expect(requirementCalls).toHaveLength(1);

      await Job.deleteMany({});
      await startRanking();
      await waitForJob('done');
      expect(requirementCalls).toHaveLength(1); // reused

      await InterviewReport.updateOne({ _id: reportA._id }, { $set: { jobDescription: 'A completely different role: data engineer.' } });
      await Job.deleteMany({});
      await startRanking();
      await waitForJob('done');
      expect(requirementCalls).toHaveLength(2);
    });

    it('running again replaces the ranking and resets the confirmation', async () => {
      await startRanking();
      await waitForJob('done');
      await putSelection({ repoIds: [1] });
      expect((await RepoRanking.findOne({ report: reportA._id })).selectionConfirmedAt).not.toBeNull();

      await Job.deleteMany({});
      await startRanking();
      await waitForJob('done');
      expect(await RepoRanking.countDocuments({ report: reportA._id })).toBe(1);
      expect((await RepoRanking.findOne({ report: reportA._id })).selectionConfirmedAt).toBeNull();
    });

    it('is idempotent: starting while a ranking is running returns the same job', async () => {
      let release;
      gate = new Promise((resolve) => {
        release = resolve;
      });
      const first = await startRanking();
      const second = await startRanking();
      expect(second.status).toBe(202);
      expect(second.body.jobId).toBe(first.body.jobId);
      expect(second.body.isNew).toBe(false);
      expect(await Job.countDocuments({ type: 'repo_ranking' })).toBe(1);
      release();
      await waitForJob('done');
    });

    it('fails the job with a clear message when no repository is eligible', async () => {
      connectState.repos = [repoRow(6, 'forked', { selectable: false })];
      await startRanking();
      const job = await waitForJob('failed');
      expect(job.error.code).toBe('NO_ELIGIBLE_REPOS');
      expect(job.error.message).toMatch(/public repositories you own/i);
      expect(await RepoRanking.countDocuments()).toBe(0);
    });

    it('fails the job when the job description has no usable requirements', async () => {
      const { JobRequirementsError } = require('../../../src/v2/services/jobRequirements.service');
      const { createRepoRankingService } = require('../../../src/v2/services/repoRanking.service');
      const { buildLinkUpdate } = require('../../../src/v2/services/githubEvidence.service');
      const { connectService } = buildApi();
      api.setRepoRankingService(
        createRepoRankingService({
          connectService,
          githubEvidenceService: { analyzeRepository: vi.fn() },
          llmClient: { embedTexts: vi.fn() },
          requirementsService: {
            extractRequirements: async () => {
              throw new JobRequirementsError('No concrete requirements could be found in the job description.');
            },
          },
          RankingModel: RepoRanking,
          ReportModel: InterviewReport,
          LinkModel: ReportProjectLink,
          buildLinkUpdate,
        })
      );
      await startRanking();
      const job = await waitForJob('failed');
      expect(job.error.code).toBe('NO_JOB_REQUIREMENTS');
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('budgets', () => {
    it('blocks with 429 once the daily ranking cap is reached and creates no job', async () => {
      process.env.USER_DAILY_RANKINGS = '1';
      await Job.create({ user: kit.userA.id, report: reportA._id, type: 'repo_ranking', status: 'done' });
      const res = await startRanking();
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('DAILY_BUDGET_REACHED');
      expect(res.body.message).toMatch(/daily project ranking limit reached/i);
      expect(await Job.countDocuments()).toBe(1);
    });

    it('applies the shared AI generation and embedding budgets', async () => {
      const { getMidnightPacific } = require('../../../src/v2/core/budgetGuards');
      const { getCfg } = require('../../../src/v2/config/env');
      process.env.LLM_DAILY_BUDGET = '1';
      await LlmCall.create({ purpose: 'x', model: getCfg().GEMINI_MODEL, ok: true, ms: 1, createdAt: new Date(getMidnightPacific().getTime() + 1000) });
      expect((await startRanking()).status).toBe(429);
      delete process.env.LLM_DAILY_BUDGET;

      process.env.EMBEDDING_DAILY_BUDGET = '1';
      await LlmCall.create({ purpose: 'y', model: getCfg().EMBEDDING_MODEL, ok: true, ms: 1, createdAt: new Date(getMidnightPacific().getTime() + 1000) });
      expect((await startRanking()).status).toBe(429);
      expect(await Job.countDocuments()).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('confirming the selection', () => {
    beforeEach(async () => {
      await startRanking();
      await waitForJob('done');
    });

    it('links the chosen repositories to the report as verified evidence and stores the choice', async () => {
      const res = await putSelection({ repoIds: [1, 2] });
      expect(res.status).toBe(200);
      expect(res.body.selectedRepoIds).toEqual([1, 2]);
      expect(res.body.selectionConfirmedAt).toBeTruthy();

      const links = await ReportProjectLink.find({ report: reportA._id }).lean();
      expect(links).toHaveLength(2);
      for (const link of links) {
        expect(link.control).toMatchObject({ verified: true, method: 'github_app_identity', githubLogin: 'alice-gh' });
        expect(link.authorship).toBe('not_assessed');
      }
      expect(links.map((l) => l.repoUrl).sort()).toEqual(['https://github.com/alice-gh/node-api', 'https://github.com/alice-gh/rag-bot']);
    });

    it('allows swapping the pre-selected repository for another ranked one', async () => {
      const res = await putSelection({ repoIds: [1, 3] });
      expect(res.status).toBe(200);
      expect((await RepoRanking.findOne({ report: reportA._id })).selectedRepoIds).toEqual([1, 3]);
    });

    it('is idempotent: confirming twice creates each link once', async () => {
      await putSelection({ repoIds: [1] });
      await putSelection({ repoIds: [1] });
      expect(await ReportProjectLink.countDocuments({ report: reportA._id })).toBe(1);
    });

    it('rejects more repositories than the limit (400) and changes nothing', async () => {
      const res = await putSelection({ repoIds: [1, 2, 3] }); // limit is 2 in this test
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TOO_MANY_REPOS');
      expect(await ReportProjectLink.countDocuments()).toBe(0);
    });

    it.each([
      ['a skipped repository (no README)', [4]],
      ['a repository that failed to analyse', [5]],
      ['a repository that is not in the ranking', [999]],
    ])('rejects %s', async (_label, repoIds) => {
      const res = await putSelection({ repoIds });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REPO');
      expect(await ReportProjectLink.countDocuments()).toBe(0);
    });

    it('checks ownership with GitHub again at confirmation time and links nothing if it is gone', async () => {
      connectState.ownedIds.delete(2);
      const res = await putSelection({ repoIds: [1, 2] });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('REPO_UNSUPPORTED');
      expect(await ReportProjectLink.countDocuments()).toBe(0); // all or nothing
      expect((await RepoRanking.findOne({ report: reportA._id })).selectionConfirmedAt).toBeNull();
    });

    it('validates the body strictly', async () => {
      expect((await putSelection({ repoIds: [] })).status).toBe(400);
      expect((await putSelection({ repoIds: ['1'] })).status).toBe(400);
      expect((await putSelection({})).status).toBe(400);
      expect((await putSelection({ repoIds: [1], control: { verified: true } })).status).toBe(400);
    });

    it('deduplicates repeated ids', async () => {
      const res = await putSelection({ repoIds: [1, 1] });
      expect(res.status).toBe(200);
      expect(res.body.selectedRepoIds).toEqual([1]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('data deletion', () => {
    it('deleting a plan removes its ranking', async () => {
      await startRanking();
      await waitForJob('done');
      expect(await RepoRanking.countDocuments({ report: reportA._id })).toBe(1);

      const res = await kit.agentA.delete(`/api/interview/report/${reportA._id}`);
      expect(res.status).toBe(200);
      expect(await RepoRanking.countDocuments({ report: reportA._id })).toBe(0);
    });
  });
});
