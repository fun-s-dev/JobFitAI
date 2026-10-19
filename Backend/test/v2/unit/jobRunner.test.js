import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  runVerificationJob,
  cleanupInterruptedJobs,
  startVerificationJob,
} = require('../../../src/v2/services/jobRunner');
const { QuotaExhaustedError } = require('../../../src/v2/errors/LlmErrors');

describe('services/jobRunner (unit)', () => {
  let mockJob;
  let mockJobModel;
  let mockVerificationService;

  beforeEach(() => {
    mockJob = {
      _id: 'job-123',
      user: 'user-abc',
      report: 'report-xyz',
      type: 'verification',
      status: 'queued',
      progress: { done: 0, total: 0 },
      resultRef: null,
      error: null,
      startedAt: null,
      finishedAt: null,
      save: vi.fn().mockImplementation(async function () {
        return this;
      }),
    };

    mockJobModel = {
      findById: vi.fn().mockResolvedValue(mockJob),
      findOne: vi.fn(),
      create: vi.fn(),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
      updateMany: vi.fn().mockResolvedValue({ modifiedCount: 2 }),
    };

    mockVerificationService = {
      verifyReport: vi.fn(),
    };
  });

  describe('runVerificationJob lifecycle', () => {
    it('transitions queued -> running -> done and updates progress', async () => {
      mockVerificationService.verifyReport.mockImplementation(async ({ onProgress }) => {
        // simulate 2 claims progress updates
        await onProgress({ done: 1, total: 2 });
        await onProgress({ done: 2, total: 2 });
        return {
          run: { _id: 'run-999' },
          claims: [{ id: 'c1' }, { id: 'c2' }],
        };
      });

      await runVerificationJob({
        jobId: 'job-123',
        verificationService: mockVerificationService,
        jobModel: mockJobModel,
      });

      expect(mockJob.status).toBe('done');
      expect(mockJob.resultRef).toBe('run-999');
      expect(mockJob.startedAt).toBeInstanceOf(Date);
      expect(mockJob.finishedAt).toBeInstanceOf(Date);
      expect(mockJob.save).toHaveBeenCalledTimes(1); // 1 on running
      expect(mockJobModel.updateOne).toHaveBeenCalledWith(
        { _id: 'job-123' },
        expect.objectContaining({
          $set: expect.objectContaining({ status: 'done', resultRef: 'run-999' }),
        })
      );

      // Verify progress updates occurred
      expect(mockJobModel.updateOne).toHaveBeenCalledWith(
        { _id: 'job-123' },
        { $set: { 'progress.done': 1, 'progress.total': 2 } }
      );
      expect(mockJobModel.updateOne).toHaveBeenCalledWith(
        { _id: 'job-123' },
        { $set: { 'progress.done': 2, 'progress.total': 2 } }
      );
    });

    it('handles QuotaExhaustedError by failing the job with a clear message', async () => {
      mockVerificationService.verifyReport.mockRejectedValue(
        new QuotaExhaustedError('Daily quota of 500 requests reached')
      );

      await runVerificationJob({
        jobId: 'job-123',
        verificationService: mockVerificationService,
        jobModel: mockJobModel,
      });

      expect(mockJob.status).toBe('failed');
      expect(mockJob.error.code).toBe('QUOTA_EXHAUSTED');
      expect(mockJob.error.message).toMatch(/quota/i);
      expect(mockJob.finishedAt).toBeInstanceOf(Date);
    });

    it('handles generic error by marking job failed', async () => {
      const genericError = new Error('Database connection dropped');
      genericError.code = 'DB_DROP';
      mockVerificationService.verifyReport.mockRejectedValue(genericError);

      await runVerificationJob({
        jobId: 'job-123',
        verificationService: mockVerificationService,
        jobModel: mockJobModel,
      });

      expect(mockJob.status).toBe('failed');
      expect(mockJob.error.code).toBe('DB_DROP');
      expect(mockJob.error.message).toBe('Database connection dropped');
      expect(mockJob.finishedAt).toBeInstanceOf(Date);
    });
  });

  describe('startVerificationJob (idempotency)', () => {
    it('returns existing active job on duplicate start (double-click defense)', async () => {
      const activeJob = {
        _id: 'existing-job',
        status: 'running',
        progress: { done: 3, total: 10 },
      };
      mockJobModel.findOne.mockResolvedValue(activeJob);

      const result = await startVerificationJob({
        userId: 'user-abc',
        reportId: 'report-xyz',
        verificationService: mockVerificationService,
        jobModel: mockJobModel,
      });

      expect(result.isNew).toBe(false);
      expect(result.job._id).toBe('existing-job');
      expect(mockJobModel.create).not.toHaveBeenCalled();
    });

    it('creates new job and queues background execution if no active job exists', async () => {
      mockJobModel.findOne.mockResolvedValue(null);
      const newJob = {
        _id: 'new-job-1',
        status: 'queued',
        progress: { done: 0, total: 0 },
      };
      mockJobModel.create.mockResolvedValue(newJob);

      const result = await startVerificationJob({
        userId: 'user-abc',
        reportId: 'report-xyz',
        verificationService: mockVerificationService,
        jobModel: mockJobModel,
      });

      expect(result.isNew).toBe(true);
      expect(result.job._id).toBe('new-job-1');
      expect(mockJobModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          user: 'user-abc',
          report: 'report-xyz',
          status: 'queued',
        })
      );
    });

    it('catches duplicate key error (code 11000) from partial unique index and returns existing job', async () => {
      mockJobModel.findOne
        .mockResolvedValueOnce(null) // first check
        .mockResolvedValueOnce({ _id: 'race-job', status: 'queued' }); // after code 11000

      const duplicateKeyErr = new Error('E11000 duplicate key error');
      duplicateKeyErr.code = 11000;
      mockJobModel.create.mockRejectedValue(duplicateKeyErr);

      const result = await startVerificationJob({
        userId: 'user-abc',
        reportId: 'report-xyz',
        verificationService: mockVerificationService,
        jobModel: mockJobModel,
      });

      expect(result.isNew).toBe(false);
      expect(result.job._id).toBe('race-job');
    });
  });

  describe('cleanupInterruptedJobs (boot recovery)', () => {
    it('marks running jobs as failed with INTERRUPTED on server boot', async () => {
      const result = await cleanupInterruptedJobs({ jobModel: mockJobModel });

      expect(mockJobModel.updateMany).toHaveBeenCalledWith(
        { status: 'running' },
        {
          $set: {
            status: 'failed',
            error: {
              code: 'INTERRUPTED',
              message: 'Job interrupted by server restart',
            },
            finishedAt: expect.any(Date),
          },
        }
      );
      expect(result.modifiedCount).toBe(2);
    });
  });
});
