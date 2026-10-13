import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createEvidenceMatchingService } = require('../../../src/v2/services/evidenceMatching.service');

describe('services/evidenceMatching.service', () => {
  const fakeLlmClient = {
    async embedTexts(texts) {
      // Return synthetic 3D unit vectors based on text keywords
      const vectors = texts.map((t) => {
        const lower = t.toLowerCase();
        if (lower.includes('redis') || lower.includes('cache')) {
          return [1, 0, 0];
        }
        if (lower.includes('express') || lower.includes('api')) {
          return [0, 1, 0];
        }
        if (lower.includes('react') || lower.includes('frontend')) {
          return [0, 0, 1];
        }
        // Neutral vector
        return [0.577, 0.577, 0.577];
      });
      return {
        vectors,
        stats: { hits: 0, misses: texts.length, apiCalls: 1 },
      };
    },
  };

  const sampleChunks = [
    { id: 'resume_chunk_0', text: 'Built Redis caching layer', embedText: 'Experience: Built Redis caching layer' },
    { id: 'resume_chunk_1', text: 'Developed Express REST APIs', embedText: 'Experience: Developed Express REST APIs' },
    { id: 'resume_chunk_2', text: 'Implemented React UI with Tailwind', embedText: 'Projects: Implemented React UI with Tailwind' },
    { id: 'resume_chunk_3', text: 'Configured Docker and CI/CD', embedText: 'DevOps: Configured Docker and CI/CD' },
  ];

  it('embeds chunks ONCE and matches claims against precomputed chunk vectors', async () => {
    const embedSpy = vi.spyOn(fakeLlmClient, 'embedTexts');
    const service = createEvidenceMatchingService({
      llmClient: fakeLlmClient,
      cfg: { SIM_LO: 0.5, SIM_HI: 0.9 },
    });

    // 1. Prepare chunks once
    const { chunksWithVectors } = await service.prepareEvidenceChunks(sampleChunks);
    expect(embedSpy).toHaveBeenCalledTimes(1);
    expect(chunksWithVectors).toHaveLength(4);

    // 2. Match claim 1
    const match1 = await service.matchClaim('Set up Redis cache for database', chunksWithVectors, { k: 2 });
    expect(embedSpy).toHaveBeenCalledTimes(2); // Only 1 additional call to embed the claim
    expect(match1).toHaveLength(2);
    expect(match1[0].chunk.id).toBe('resume_chunk_0');
    expect(match1[0].rawCosine).toBeCloseTo(1.0, 5);
    expect(match1[0].similarityScore).toBe(1.0);

    // 3. Match claim 2 (chunks are NOT re-embedded!)
    const match2 = await service.matchClaim('Built backend REST APIs in Express', chunksWithVectors, { k: 2 });
    expect(embedSpy).toHaveBeenCalledTimes(3); // Only 1 more call for claim 2
    expect(match2[0].chunk.id).toBe('resume_chunk_1');
    expect(match2[0].rawCosine).toBeCloseTo(1.0, 5);
    expect(match2[0].similarityScore).toBe(1.0);
  });

  it('rescales raw cosine using config SIM_LO and SIM_HI', async () => {
    const customService = createEvidenceMatchingService({
      llmClient: {
        async embedTexts(texts) {
          // Claim vector [0.8, 0.6], chunk vector [1, 0] -> dot = 0.8
          if (texts[0].includes('Claim')) return { vectors: [[0.8, 0.6]] };
          return { vectors: [[1, 0]] };
        },
      },
      cfg: { SIM_LO: 0.6, SIM_HI: 1.0 },
    });

    const chunk = { id: 'c0', text: 'Target chunk', embedText: 'Target chunk' };
    const { chunksWithVectors } = await customService.prepareEvidenceChunks([chunk]);
    const matches = await customService.matchClaim('Claim text', chunksWithVectors, { k: 1 });

    expect(matches).toHaveLength(1);
    expect(matches[0].rawCosine).toBeCloseTo(0.8, 5);
    // (0.8 - 0.6) / (1.0 - 0.6) = 0.2 / 0.4 = 0.5
    expect(matches[0].similarityScore).toBeCloseTo(0.5, 5);
  });
});
