import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const InterviewReport = require('../../../src/models/interviewReport.model');
const ResumeDraft = require('../../../src/v2/models/resumeDraft.model');
const VerificationRun = require('../../../src/v2/models/verificationRun.model');
const ResumeClaim = require('../../../src/v2/models/resumeClaim.model');
const { createVerificationService } = require('../../../src/v2/services/verification.service');

describe('verification.service transaction integration (MongoMemoryReplSet)', () => {
  let replSet;
  let service;
  let testUserId;
  let testReportId;
  let originalInsertMany;

  beforeAll(async () => {
    // Spin up real replica set supporting MongoDB ACID multi-document transactions
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const uri = replSet.getUri();
    await mongoose.connect(uri);

    // Pre-create collections and indexes so transactions do not encounter implicit collection creation DDL errors
    await VerificationRun.createCollection();
    await ResumeClaim.createCollection();
    await VerificationRun.init();
    await ResumeClaim.init();

    originalInsertMany = ResumeClaim.insertMany.bind(ResumeClaim);
  }, 60000);

  afterAll(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    if (replSet) {
      await replSet.stop();
    }
  }, 60000);

  beforeEach(async () => {
    // Restore any patched methods
    ResumeClaim.insertMany = originalInsertMany;

    // Clear collections
    await VerificationRun.deleteMany({});
    await ResumeClaim.deleteMany({});
    await ResumeDraft.deleteMany({});
    await InterviewReport.deleteMany({});

    testUserId = new mongoose.Types.ObjectId();
    testReportId = new mongoose.Types.ObjectId();

    await InterviewReport.create({
      _id: testReportId,
      user: testUserId,
      title: 'Senior Backend Engineer',
      resumeText: 'Experienced Node.js and MongoDB backend engineer with cloud microservices experience.',
      jobDescription: 'Backend engineer role requiring Node.js.',
    });

    await ResumeDraft.create({
      report: testReportId,
      user: testUserId,
      draft: {
        summary: 'Backend Engineer',
        experience: [
          {
            id: 'exp0',
            company: 'Acme',
            role: 'Software Engineer',
            dates: '2022 - Present',
            bullets: [
              { id: 'exp0.b0', text: 'Built Node.js microservices handling 10k RPS.' },
              { id: 'exp0.b1', text: 'Optimized MongoDB aggregation pipelines.' },
            ],
          },
        ],
        projects: [],
        skills: ['Node.js', 'MongoDB'],
        education: [],
      },
    });

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
          chunk: chunksWithVectors[0]?.chunk || { id: 'c1', text: 'Built Node.js microservices', section: 'Experience' },
          rawCosine: 0.88,
          similarityScore: 0.9,
        },
      ],
    };

    const mockEntailment = {
      evaluateClaim: async () => ({
        verdict: 'yes',
        rawVerdict: 'yes',
        evidenceQuote: 'Built Node.js microservices',
        missingElements: [],
        quoteUngrounded: false,
        caps: [],
        entailmentScore: 1.0,
      }),
    };

    const mockClaimExtraction = {
      extractClaimsFromBullets: async () => ({
        claims: [
          {
            bulletId: 'exp0.b0',
            claimText: 'Built Node.js microservices handling 10k RPS',
            claimType: 'metric',
            skills: ['Node.js'],
            numbers: ['10k RPS'],
          },
          {
            bulletId: 'exp0.b1',
            claimText: 'Optimized MongoDB aggregation pipelines',
            claimType: 'technology',
            skills: ['MongoDB'],
            numbers: [],
          },
        ],
        incompleteBullets: [],
      }),
    };

    const mockLlmClient = {
      embedTexts: async (texts) => ({
        vectors: texts.map(() => [0.1, 0.2, 0.3]),
        stats: { hits: 0, misses: texts.length, apiCalls: 1 },
      }),
    };

    service = createVerificationService({
      llmClient: mockLlmClient,
      evidenceMatchingService: mockEvidenceMatching,
      entailmentService: mockEntailment,
      claimExtractionService: mockClaimExtraction,
      repos: {
        InterviewReport,
        ResumeDraft,
        VerificationRun,
        ResumeClaim,
      },
      cfg: {
        CONFIDENCE_WEIGHT_SIMILARITY: 0.4,
        CONFIDENCE_WEIGHT_ENTAILMENT: 0.6,
        STATUS_VERIFIED_THRESHOLD: 0.75,
        STATUS_NEEDS_REVIEW_THRESHOLD: 0.45,
      },
    });
  });

  it('(a) success commits the run and its claims inside a replica-set transaction', async () => {
    const result = await service.verifyReport({
      reportId: testReportId.toString(),
      userId: testUserId.toString(),
    });

    expect(result.run).toBeDefined();
    expect(result.claims).toHaveLength(2);

    // Verify persisted in DB
    const persistedRun = await VerificationRun.findById(result.run._id);
    expect(persistedRun).not.toBeNull();
    expect(persistedRun.report.toString()).toBe(testReportId.toString());

    const persistedClaims = await ResumeClaim.find({ run: result.run._id });
    expect(persistedClaims).toHaveLength(2);
    expect(persistedClaims.map((c) => c.status)).toEqual(['verified', 'verified']);
  });

  it('(b) failure injected during ResumeClaim.insertMany aborts transaction and leaves ZERO runs and claims', async () => {
    // Inject failure on ResumeClaim.insertMany while transaction is in flight
    ResumeClaim.insertMany = async function (..._args) {
      throw new Error('Injected replica-set transaction failure during bulk claim insert');
    };

    await expect(
      service.verifyReport({
        reportId: testReportId.toString(),
        userId: testUserId.toString(),
      })
    ).rejects.toMatchObject({
      status: 503,
      code: 'UPSTREAM_UNAVAILABLE',
    });

    // Confirm that transaction rollback left ZERO runs and ZERO claims
    const runCount = await VerificationRun.countDocuments({ report: testReportId });
    const claimCount = await ResumeClaim.countDocuments({ report: testReportId });

    expect(runCount).toBe(0);
    expect(claimCount).toBe(0);
  });
});
