import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestKit, teardownTestKit } from '../../helpers/testKit.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const InterviewReport = require('../../../src/models/interviewReport.model');
const Job = require('../../../src/v2/models/job');
const { failOrphanedQueuedJobs } = require('../../../src/v2/services/jobRunner');
const {
  setVerificationService,
  setVerificationSyncMode,
} = require('../../../src/v2/controllers/verification.controller');

describe('V2 job recovery and production sync guard', () => {
  let kit;
  let report;
  const fakeService = { verifyReport: vi.fn(async () => ({ run: { _id: '000000000000000000000001' }, claims: [] })) };

  beforeAll(async () => {
    kit = await setupTestKit();
    setVerificationService(fakeService); // background jobs must never reach a real LLM
  });

  afterAll(async () => {
    setVerificationService(null);
    setVerificationSyncMode(false);
    await teardownTestKit();
  });

  beforeEach(async () => {
    fakeService.verifyReport.mockClear();
    await Job.deleteMany({});
    await InterviewReport.deleteMany({});
    report = await InterviewReport.create({
      user: kit.userA.id,
      title: 'Backend Engineer',
      jobDescription: 'Backend engineer role with Node.js.',
      resume: 'Built APIs in Node.js.',
    });
  });

  async function waitForNoActiveJobs() {
    await vi.waitFor(async () => {
      expect(await Job.countDocuments({ status: { $in: ['queued', 'running'] } })).toBe(0);
    });
  }

  it('an orphaned queued job blocks retries until boot recovery marks it failed', async () => {
    // A job whose process died before it started: still "queued", never picked up
    const orphan = await Job.create({
      user: kit.userA.id,
      report: report._id,
      type: 'verification',
      status: 'queued',
    });

    // Before recovery the user is handed the dead job again and nothing runs
    const blocked = await kit.agentA.post(`/api/v2/verification/${report._id}`).send({});
    expect(blocked.status).toBe(202);
    expect(blocked.body.jobId).toBe(String(orphan._id));
    expect(fakeService.verifyReport).not.toHaveBeenCalled();

    // Boot recovery
    const result = await failOrphanedQueuedJobs();
    expect(result.modifiedCount).toBe(1);

    const recovered = await Job.findById(orphan._id).lean();
    expect(recovered.status).toBe('failed');
    expect(recovered.error.code).toBe('INTERRUPTED');
    expect(recovered.finishedAt).toBeInstanceOf(Date);

    // The user can retry and a fresh job really runs
    const retry = await kit.agentA.post(`/api/v2/verification/${report._id}`).send({});
    expect(retry.status).toBe(202);
    expect(retry.body.jobId).not.toBe(String(orphan._id));
    await vi.waitFor(() => expect(fakeService.verifyReport).toHaveBeenCalledTimes(1));
    await waitForNoActiveJobs();
  });

  it('recovery leaves finished jobs and other statuses untouched', async () => {
    const done = await Job.create({ user: kit.userA.id, report: report._id, type: 'verification', status: 'done' });
    const result = await failOrphanedQueuedJobs();
    expect(result.modifiedCount).toBe(0);
    expect((await Job.findById(done._id).lean()).status).toBe('done');
  });

  it('ignores a client-supplied sync flag in production and still queues a background job', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await kit.agentA.post(`/api/v2/verification/${report._id}?sync=true`).send({ sync: true });
      expect(res.status).toBe(202);
      expect(res.body.jobId).toBeDefined();
      expect(res.body.run).toBeUndefined();
    } finally {
      process.env.NODE_ENV = previous;
    }
    await waitForNoActiveJobs();
  });

  it('still honours sync outside production (tests and local debugging)', async () => {
    const res = await kit.agentA.post(`/api/v2/verification/${report._id}?sync=true`).send({});
    expect(res.status).toBe(200);
    expect(res.body.run).toBeDefined();
  });
});
