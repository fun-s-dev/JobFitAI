import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { setupTestKit, teardownTestKit } from './helpers/testKit.js';

/**
 * Deleting a report or an account removes the personal data (resume text, drafts, claims) and
 * everything derived from it. Real routes and models; only the GitHub revoke boundary is not exercised.
 */
describe('Data deletion: reports and accounts', () => {
  let kit;
  let M; // models
  let objectId;

  async function seedReportGraph(userId, suffix = 'a') {
    const report = await M.InterviewReport.create({
      user: userId,
      title: `Synthetic role ${suffix}`,
      jobDescription: 'Backend engineer role with Node.js and MongoDB.',
      resume: `Synthetic resume text ${suffix}.`,
      selfDescription: 'Synthetic self description.',
      matchScore: 70,
    });
    const draft = await M.ResumeDraft.create({
      report: report._id,
      user: userId,
      draft: { summary: 's', experience: [], projects: [], skills: [], education: [] },
    });
    const run = await M.VerificationRun.create({
      report: report._id,
      user: userId,
      draft: draft._id,
      config: { weights: {}, thresholds: {} },
    });
    await M.ResumeClaim.create({
      run: run._id,
      report: report._id,
      user: userId,
      bulletId: 'exp0.b0',
      claimText: 'Synthetic claim',
      confidenceScore: 0.9,
      status: 'verified',
      entailment: { verdict: 'yes', score: 1 },
      provenance: { generationModel: 'm' },
    });
    const analysisId = new objectId();
    await M.ReportProjectLink.create({ report: report._id, user: userId, analysisId, repoUrl: 'https://github.com/a/b' });
    await M.Job.create({ user: userId, report: report._id, type: 'verification', status: 'done' });
    return { report, analysisId };
  }

  const countsFor = async (reportId) => ({
    report: await M.InterviewReport.countDocuments({ _id: reportId }),
    drafts: await M.ResumeDraft.countDocuments({ report: reportId }),
    runs: await M.VerificationRun.countDocuments({ report: reportId }),
    claims: await M.ResumeClaim.countDocuments({ report: reportId }),
    links: await M.ReportProjectLink.countDocuments({ report: reportId }),
    jobs: await M.Job.countDocuments({ report: reportId }),
  });
  const ALL_PRESENT = { report: 1, drafts: 1, runs: 1, claims: 1, links: 1, jobs: 1 };
  const ALL_GONE = { report: 0, drafts: 0, runs: 0, claims: 0, links: 0, jobs: 0 };

  beforeAll(async () => {
    process.env.RATE_LIMIT_LOGIN_MAX = '1000';
    kit = await setupTestKit();
    objectId = kit.mongoose.Types.ObjectId;
    M = {
      InterviewReport: kit.require('../../src/models/interviewReport.model'),
      ResumeDraft: kit.require('../../src/v2/models/resumeDraft.model'),
      VerificationRun: kit.require('../../src/v2/models/verificationRun.model'),
      ResumeClaim: kit.require('../../src/v2/models/resumeClaim.model'),
      ReportProjectLink: kit.require('../../src/v2/models/reportProjectLink.model'),
      Job: kit.require('../../src/v2/models/job'),
      LlmCall: kit.require('../../src/v2/models/llmCall.model'),
      GithubConnection: kit.require('../../src/v2/models/githubConnection.model'),
      GithubAnalysis: kit.require('../../src/v2/models/githubAnalysis'),
      User: kit.require('../../src/models/user.model'),
    };
  });

  afterAll(async () => {
    delete process.env.RATE_LIMIT_LOGIN_MAX;
    await teardownTestKit();
  });

  beforeEach(async () => {
    await Promise.all(
      ['InterviewReport', 'ResumeDraft', 'VerificationRun', 'ResumeClaim', 'ReportProjectLink', 'Job', 'LlmCall', 'GithubConnection', 'GithubAnalysis'].map((k) => M[k].deleteMany({}))
    );
  });

  describe('DELETE /api/interview/report/:id', () => {
    it('removes the report with its drafts, runs, claims, repository links and jobs', async () => {
      const { report } = await seedReportGraph(kit.userA.id);
      expect(await countsFor(report._id)).toEqual(ALL_PRESENT);

      const res = await kit.agentA.delete(`/api/interview/report/${report._id}`);

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
      expect(res.body.counts).toMatchObject({ claims: 1, runs: 1, drafts: 1, repositoryLinks: 1, jobs: 1, reports: 1 });
      expect(await countsFor(report._id)).toEqual(ALL_GONE);

      const get = await kit.agentA.get(`/api/interview/report/${report._id}`);
      expect(get.status).toBe(404);
    });

    it('leaves the user’s other reports and the shared GitHub analysis cache untouched', async () => {
      const first = await seedReportGraph(kit.userA.id, 'one');
      const second = await seedReportGraph(kit.userA.id, 'two');
      await M.GithubAnalysis.create({ repositoryUrl: 'https://github.com/a/b', repositoryFullName: 'a/b', commitSha: 'abc' });

      await kit.agentA.delete(`/api/interview/report/${first.report._id}`);

      expect(await countsFor(second.report._id)).toEqual(ALL_PRESENT);
      expect(await M.GithubAnalysis.countDocuments()).toBe(1);
    });

    it('refuses to touch another user’s report (404) and deletes nothing', async () => {
      const { report } = await seedReportGraph(kit.userA.id);

      const res = await kit.agentB.delete(`/api/interview/report/${report._id}`);

      expect(res.status).toBe(404);
      expect(await countsFor(report._id)).toEqual(ALL_PRESENT);
    });

    it('requires login and a well-formed id', async () => {
      const { report } = await seedReportGraph(kit.userA.id);
      expect((await request(kit.app).delete(`/api/interview/report/${report._id}`)).status).toBe(401);
      expect((await kit.agentA.delete('/api/interview/report/not-an-id')).status).toBe(404);
      expect(await countsFor(report._id)).toEqual(ALL_PRESENT);
    });

    it('refuses with 409 while a job for the report is still running, and deletes nothing', async () => {
      const { report } = await seedReportGraph(kit.userA.id);
      await M.Job.create({ user: kit.userA.id, report: report._id, type: 'github_analysis', status: 'running' });

      const res = await kit.agentA.delete(`/api/interview/report/${report._id}`);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('JOB_IN_PROGRESS');
      expect((await countsFor(report._id)).report).toBe(1);
    });

    it('is safe to repeat: the second delete is a clean 404', async () => {
      const { report } = await seedReportGraph(kit.userA.id);
      expect((await kit.agentA.delete(`/api/interview/report/${report._id}`)).status).toBe(200);
      expect((await kit.agentA.delete(`/api/interview/report/${report._id}`)).status).toBe(404);
    });
  });

  describe('DELETE /api/auth/account', () => {
    it('requires login and a password', async () => {
      expect((await request(kit.app).delete('/api/auth/account').send({ password: 'Password123!' })).status).toBe(401);

      const missing = await kit.agentA.delete('/api/auth/account').send({});
      expect(missing.status).toBe(400);
      expect(missing.body.message).toMatch(/enter your password/i);
    });

    it('rejects a wrong password and keeps all data', async () => {
      const { report } = await seedReportGraph(kit.userA.id);

      const res = await kit.agentA.delete('/api/auth/account').send({ password: 'WrongPassword1!' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PASSWORD');
      expect(await M.User.countDocuments({ _id: kit.userA.id })).toBe(1);
      expect(await countsFor(report._id)).toEqual(ALL_PRESENT);
    });

    it('deletes the user, all their data and GitHub connection, anonymizes the usage ledger and ends the session', async () => {
      const a1 = await seedReportGraph(kit.userA.id, 'one');
      const a2 = await seedReportGraph(kit.userA.id, 'two');
      const b = await seedReportGraph(kit.userB.id, 'bob');
      await M.GithubConnection.create({ user: kit.userA.id, githubUserId: 1001, login: 'alice-gh', status: 'active' });
      await M.LlmCall.create({ user: kit.userA.id, purpose: 'interview_report', model: 'm', ok: true, ms: 1 });
      await M.LlmCall.create({ user: kit.userB.id, purpose: 'interview_report', model: 'm', ok: true, ms: 1 });

      const res = await kit.agentA.delete('/api/auth/account').send({ password: 'Password123!' });

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/deleted/i);

      // user and everything derived from their reports
      expect(await M.User.countDocuments({ _id: kit.userA.id })).toBe(0);
      expect(await countsFor(a1.report._id)).toEqual(ALL_GONE);
      expect(await countsFor(a2.report._id)).toEqual(ALL_GONE);
      expect(await M.GithubConnection.countDocuments({ user: kit.userA.id })).toBe(0);

      // usage ledger rows stay (budgets) but no longer point at the user
      expect(await M.LlmCall.countDocuments({ user: kit.userA.id })).toBe(0);
      expect(await M.LlmCall.countDocuments({ user: null })).toBe(1);

      // the session is over: cookie cleared and token blacklisted
      const cookie = res.headers['set-cookie'].find((c) => c.startsWith('token='));
      expect(cookie).toMatch(/Expires=/i);
      expect((await kit.agentA.get('/api/auth/get-me')).status).toBe(401);

      // the account can no longer log in
      const login = await request(kit.app).post('/api/auth/login').send({ email: 'alice@example.com', password: 'Password123!' });
      expect(login.status).toBe(400);

      // another user is completely unaffected
      expect(await M.User.countDocuments({ _id: kit.userB.id })).toBe(1);
      expect(await countsFor(b.report._id)).toEqual(ALL_PRESENT);
      expect(await M.LlmCall.countDocuments({ user: kit.userB.id })).toBe(1);
    });

    it('refuses with 409 while a job of the user is running and deletes nothing', async () => {
      const { report } = await seedReportGraph(kit.userB.id, 'bob');
      await M.Job.create({ user: kit.userB.id, report: report._id, type: 'verification', status: 'queued' });

      const res = await kit.agentB.delete('/api/auth/account').send({ password: 'Password123!' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('JOB_IN_PROGRESS');
      expect(await M.User.countDocuments({ _id: kit.userB.id })).toBe(1);
      expect((await countsFor(report._id)).report).toBe(1);
    });
  });
});
