import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createClaimExtractionService } = require('../../../src/v2/services/claimExtraction.service');

describe('services/claimExtraction.service', () => {
  it('extracts atomic claims, labels bullets, omits temperature, sets thinkingLevel LOW, and normalizes skills', async () => {
    let capturedCall = null;
    const fakeLlmClient = {
      async generateStructured(params) {
        capturedCall = params;
        return {
          claims: [
            {
              bulletId: 'exp0.b0',
              claimText: 'Candidate architected a notification service',
              claimType: 'leadership',
              skills: ['node', 'rabbitmq'],
              numbers: [],
            },
            {
              bulletId: 'exp0.b0',
              claimText: 'Latency was cut by 40%',
              claimType: 'metric',
              skills: [],
              numbers: ['40%'],
            },
          ],
        };
      },
    };

    const service = createClaimExtractionService({ llmClient: fakeLlmClient, batchSize: 2 });
    const bullets = [
      { id: 'exp0.b0', text: 'Architected notification service in Node.js and RabbitMQ, cutting latency by 40%.' },
    ];

    const result = await service.extractClaimsFromBullets(bullets);

    expect(capturedCall).toBeDefined();
    expect(capturedCall.purpose).toBe('extract_atomic_claims');
    expect(capturedCall.temperature).toBeUndefined(); // default temperature
    expect(capturedCall.thinkingLevel).toBe('LOW');
    expect(capturedCall.prompt).toContain('[exp0.b0]: Architected notification service');

    expect(result.claims.length).toBe(2);
    // Skills normalized
    expect(result.claims[0].skills).toEqual(['Node.js', 'RabbitMQ']);
    expect(result.incompleteBullets).toEqual([]);
  });

  it('rejects hallucinated bullet IDs returned by the model', async () => {
    const fakeLlmClient = {
      async generateStructured() {
        return {
          claims: [
            {
              bulletId: 'exp0.b0',
              claimText: 'Valid claim',
              claimType: 'responsibility',
              skills: [],
              numbers: [],
            },
            {
              bulletId: 'hallucinated_id_999',
              claimText: 'Fake claim for unrequested bullet',
              claimType: 'other',
              skills: [],
              numbers: [],
            },
          ],
        };
      },
    };

    const service = createClaimExtractionService({ llmClient: fakeLlmClient, batchSize: 2 });
    const bullets = [{ id: 'exp0.b0', text: 'Simple bullet without numbers.' }];

    const result = await service.extractClaimsFromBullets(bullets);
    expect(result.claims.length).toBe(1);
    expect(result.claims[0].bulletId).toBe('exp0.b0');
  });

  it('retries when coverage check drops a number, and succeeds on retry', async () => {
    let callCount = 0;
    const fakeLlmClient = {
      async generateStructured() {
        callCount++;
        if (callCount === 1) {
          // First call drops the 40% number
          return {
            claims: [
              {
                bulletId: 'exp0.b0',
                claimText: 'Built REST API with Express',
                claimType: 'technology',
                skills: ['Express'],
                numbers: [],
              },
            ],
          };
        }
        // Retry call includes the number
        return {
          claims: [
            {
              bulletId: 'exp0.b0',
              claimText: 'Built REST API with Express',
              claimType: 'technology',
              skills: ['Express'],
              numbers: [],
            },
            {
              bulletId: 'exp0.b0',
              claimText: 'Cut latency by 40%',
              claimType: 'metric',
              skills: [],
              numbers: ['40%'],
            },
          ],
        };
      },
    };

    const service = createClaimExtractionService({ llmClient: fakeLlmClient, batchSize: 1 });
    const bullets = [{ id: 'exp0.b0', text: 'Built REST API with Express, cutting latency by 40%.' }];

    const result = await service.extractClaimsFromBullets(bullets);
    expect(callCount).toBe(2);
    expect(result.claims.length).toBe(2);
    expect(result.incompleteBullets).toEqual([]);
  });

  it('flags bullet as extraction_incomplete when retry still drops number or tech', async () => {
    let callCount = 0;
    const fakeLlmClient = {
      async generateStructured() {
        callCount++;
        // Both calls drop the 40% number
        return {
          claims: [
            {
              bulletId: 'exp0.b0',
              claimText: 'Built REST API with Express',
              claimType: 'technology',
              skills: ['Express'],
              numbers: [],
            },
          ],
        };
      },
    };

    const service = createClaimExtractionService({ llmClient: fakeLlmClient, batchSize: 1 });
    const bullets = [{ id: 'exp0.b0', text: 'Built REST API with Express, cutting latency by 40%.' }];

    const result = await service.extractClaimsFromBullets(bullets);
    expect(callCount).toBe(2); // Attempted retry
    expect(result.incompleteBullets).toEqual(['exp0.b0']);
  });

  it('flags bullet as extraction_incomplete when model returns zero claims for it', async () => {
    const fakeLlmClient = {
      async generateStructured() {
        return { claims: [] };
      },
    };

    const service = createClaimExtractionService({ llmClient: fakeLlmClient, batchSize: 1 });
    const bullets = [{ id: 'exp0.b0', text: 'Some bullet.' }];

    const result = await service.extractClaimsFromBullets(bullets);
    expect(result.incompleteBullets).toEqual(['exp0.b0']);
  });

  it('bubbles up a controlled error and does not return partial results when llmClient throws', async () => {
    const fakeLlmClient = {
      async generateStructured() {
        throw new Error('LLM quota exceeded');
      },
    };

    const service = createClaimExtractionService({ llmClient: fakeLlmClient });
    const bullets = [{ id: 'exp0.b0', text: 'Built scalable systems.' }];

    await expect(service.extractClaimsFromBullets(bullets)).rejects.toThrow('LLM quota exceeded');
  });
});
