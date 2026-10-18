import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createVerificationService } = require('../../../src/v2/services/verification.service');

describe('verification.service (unit)', () => {
  let mockLlmClient;
  let mockEvidenceMatchingService;
  let mockEntailmentService;
  let mockClaimExtractionService;
  let mockRepos;

  beforeEach(() => {
    mockLlmClient = {};

    mockEvidenceMatchingService = {
      prepareEvidenceChunks: vi.fn(async (chunks) => ({
        chunksWithVectors: chunks.map((c, i) => ({
          chunk: c,
          vector: [0.1 * (i + 1), 0.2, 0.3],
        })),
        stats: { hits: 0, misses: 0, apiCalls: 1 },
      })),
      matchClaim: vi.fn(async (claimText, chunksWithVectors) => [
        {
          chunk: chunksWithVectors[0]?.chunk || { id: 'c1', text: 'evidence', section: 'Experience' },
          rawCosine: 0.85,
          similarityScore: 0.875,
        },
      ]),
    };

    mockEntailmentService = {
      evaluateClaim: vi.fn(async () => ({
        verdict: 'yes',
        rawVerdict: 'yes',
        evidenceQuote: 'built microservices',
        missingElements: [],
        quoteUngrounded: false,
        caps: [],
        entailmentScore: 1.0,
      })),
    };

    mockClaimExtractionService = {
      extractClaimsFromBullets: vi.fn(async () => ({
        claims: [
          {
            bulletId: 'exp0.b0',
            claimText: 'Architected microservices in Express',
            claimType: 'technology',
            skills: ['Express'],
            numbers: [],
          },
        ],
        incompleteBullets: [],
      })),
    };

    mockRepos = {
      ResumeClaim: {
        insertMany: vi.fn(async (docs) => docs.map((d, i) => ({ ...d, _id: `claim_${i}` }))),
        deleteMany: vi.fn(async () => ({ deletedCount: 0 })),
      },
      VerificationRun: {
        create: vi.fn(async (doc) => ({
          ...(Array.isArray(doc) ? doc[0] : doc),
          _id: 'run_123',
        })),
        deleteOne: vi.fn(async () => ({ deletedCount: 1 })),
      },
      ResumeDraft: {
        findOne: vi.fn(),
      },
      InterviewReport: {
        findOne: vi.fn(),
      },
    };
  });

  describe('verifyOne (pure in-memory verification)', () => {
    it('verifies a single claim cleanly without touching the database', async () => {
      const service = createVerificationService({
        llmClient: mockLlmClient,
        evidenceMatchingService: mockEvidenceMatchingService,
        entailmentService: mockEntailmentService,
        repos: mockRepos,
      });

      const claim = {
        bulletId: 'exp0.b0',
        claimText: 'Architected microservices in Express',
        claimType: 'technology',
        skills: ['Express'],
        numbers: [],
      };

      const chunksWithVectors = [
        {
          chunk: { id: 'c1', text: 'Architected microservices with Express and Node.js', section: 'Experience' },
          vector: [0.1, 0.2, 0.3],
        },
      ];

      const result = await service.verifyOne({
        claim,
        chunksWithVectors,
        signals: { similarity: true, entailment: true, quoteGrounding: true, guardrails: true },
      });

      expect(result).toBeDefined();
      expect(result.bulletId).toBe('exp0.b0');
      expect(result.status).toBe('verified');
      expect(result.confidenceScore).toBeGreaterThanOrEqual(0.80);
      expect(result.provenance).toBeDefined();
      expect(result.provenance.weights).toBeDefined();

      // Database repos must NOT be touched
      expect(mockRepos.ResumeClaim.insertMany).not.toHaveBeenCalled();
      expect(mockRepos.VerificationRun.create).not.toHaveBeenCalled();
    });

    it('supports ablation signals (similarity=false skips embedding/matching)', async () => {
      const service = createVerificationService({
        llmClient: mockLlmClient,
        evidenceMatchingService: mockEvidenceMatchingService,
        entailmentService: mockEntailmentService,
        repos: mockRepos,
      });

      const claim = {
        bulletId: 'exp0.b0',
        claimText: 'Architected microservices in Express',
        claimType: 'technology',
      };

      const chunksWithVectors = [
        {
          chunk: { id: 'c1', text: 'Built Express API', section: 'Experience' },
          vector: [0.1, 0.2, 0.3],
        },
      ];

      const result = await service.verifyOne({
        claim,
        chunksWithVectors,
        signals: { similarity: false, entailment: true },
      });

      expect(mockEvidenceMatchingService.matchClaim).not.toHaveBeenCalled();
      expect(result.resumeEvidence).toEqual([]);
      // When similarity is null, entailment re-normalizes to 1.0 weight -> confidence = entailmentScore = 1.0
      expect(result.confidenceScore).toBe(1.0);
      expect(result.status).toBe('verified');
    });

    it('supports ablation signals (entailment=false skips judge)', async () => {
      const service = createVerificationService({
        llmClient: mockLlmClient,
        evidenceMatchingService: mockEvidenceMatchingService,
        entailmentService: mockEntailmentService,
        repos: mockRepos,
      });

      const claim = {
        bulletId: 'exp0.b0',
        claimText: 'Architected microservices in Express',
      };

      const chunksWithVectors = [
        {
          chunk: { id: 'c1', text: 'Built Express API', section: 'Experience' },
          vector: [0.1, 0.2, 0.3],
        },
      ];

      const result = await service.verifyOne({
        claim,
        chunksWithVectors,
        signals: { similarity: true, entailment: false },
      });

      expect(mockEntailmentService.evaluateClaim).not.toHaveBeenCalled();
      expect(result.entailment.verdict).toBe('no');
      // When entailment is null, similarity re-normalizes to 1.0 weight
      expect(result.confidenceScore).toBe(0.875);
    });
  });

  describe('verifyReport', () => {
    it('throws 409 draft_required when no ResumeDraft exists for the report', async () => {
      mockRepos.InterviewReport.findOne.mockResolvedValue({
        _id: '507f1f77bcf86cd799439011',
        user: '507f1f77bcf86cd799439012',
        resumeText: 'Resume text',
      });

      mockRepos.ResumeDraft.findOne.mockReturnValue({
        sort: vi.fn().mockResolvedValue(null),
      });

      const service = createVerificationService({
        llmClient: mockLlmClient,
        evidenceMatchingService: mockEvidenceMatchingService,
        entailmentService: mockEntailmentService,
        claimExtractionService: mockClaimExtractionService,
        repos: mockRepos,
      });

      await expect(
        service.verifyReport({
          reportId: '507f1f77bcf86cd799439011',
          userId: '507f1f77bcf86cd799439012',
        })
      ).rejects.toMatchObject({
        status: 409,
        code: 'draft_required',
      });
    });

    it('rolls back and cleans up VerificationRun if ResumeClaim.insertMany fails (failure-injection)', async () => {
      mockRepos.InterviewReport.findOne.mockResolvedValue({
        _id: '507f1f77bcf86cd799439011',
        user: '507f1f77bcf86cd799439012',
        resumeText: 'Worked on backend in Node.js',
      });

      mockRepos.ResumeDraft.findOne.mockReturnValue({
        sort: vi.fn().mockResolvedValue({
          _id: 'draft_999',
          draft: {
            experience: [
              {
                id: 'exp0',
                bullets: [{ id: 'exp0.b0', text: 'Built Node.js API' }],
              },
            ],
          },
        }),
      });

      // INJECT FAILURE on insertMany
      mockRepos.ResumeClaim.insertMany.mockRejectedValue(new Error('Mongo bulkWrite insertion error'));

      const service = createVerificationService({
        llmClient: mockLlmClient,
        evidenceMatchingService: mockEvidenceMatchingService,
        entailmentService: mockEntailmentService,
        claimExtractionService: mockClaimExtractionService,
        repos: mockRepos,
      });

      await expect(
        service.verifyReport({
          reportId: '507f1f77bcf86cd799439011',
          userId: '507f1f77bcf86cd799439012',
        })
      ).rejects.toMatchObject({
        status: 503,
        code: 'UPSTREAM_UNAVAILABLE',
      });

      // VerificationRun cleanup must have been called
      expect(mockRepos.VerificationRun.deleteOne).toHaveBeenCalled();
      expect(mockRepos.ResumeClaim.deleteMany).toHaveBeenCalled();
    });

    it('embeds all 12 claims in ONE single embedTexts call, passing precomputed vectors to verifyOne', async () => {
      mockRepos.InterviewReport.findOne.mockResolvedValue({
        _id: '507f1f77bcf86cd799439011',
        user: '507f1f77bcf86cd799439012',
        resumeText: 'Worked on backend in Node.js',
      });

      mockRepos.ResumeDraft.findOne.mockReturnValue({
        sort: vi.fn().mockResolvedValue({
          _id: 'draft_999',
          draft: {
            experience: [
              {
                id: 'exp0',
                bullets: [{ id: 'exp0.b0', text: 'Built Node.js API' }],
              },
            ],
          },
        }),
      });

      // Generate 12 claims
      const twelveClaims = Array.from({ length: 12 }, (_, i) => ({
        bulletId: `exp0.b${i}`,
        claimText: `Claim text number ${i}`,
        claimType: 'technology',
        skills: ['Node.js'],
        numbers: [],
      }));

      mockClaimExtractionService.extractClaimsFromBullets.mockResolvedValueOnce({
        claims: twelveClaims,
        incompleteBullets: [],
      });

      mockLlmClient.embedTexts = vi.fn().mockResolvedValue({
        vectors: twelveClaims.map(() => [0.1, 0.2, 0.3]),
        stats: { hits: 0, misses: 12, apiCalls: 1 },
      });

      const service = createVerificationService({
        llmClient: mockLlmClient,
        evidenceMatchingService: mockEvidenceMatchingService,
        entailmentService: mockEntailmentService,
        claimExtractionService: mockClaimExtractionService,
        repos: mockRepos,
      });

      const result = await service.verifyReport({
        reportId: '507f1f77bcf86cd799439011',
        userId: '507f1f77bcf86cd799439012',
      });

      expect(result.claims.length).toBe(12);
      // Exactly 1 call to embedTexts for all 12 claims
      expect(mockLlmClient.embedTexts).toHaveBeenCalledTimes(1);
      const calledTexts = mockLlmClient.embedTexts.mock.calls[0][0];
      expect(calledTexts.length).toBe(12);

      // Verify that matchClaim received the precomputed vector for each claim
      expect(mockEvidenceMatchingService.matchClaim).toHaveBeenCalledTimes(12);
      for (let i = 0; i < 12; i++) {
        const callArgs = mockEvidenceMatchingService.matchClaim.mock.calls[i];
        expect(callArgs[2].claimVector).toEqual([0.1, 0.2, 0.3]);
      }
    });
  });
});
