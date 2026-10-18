import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const { createLlmClient, createPacer } = require('../../../src/v2/adapters/llmClient');
const { LlmValidationError, QuotaExhaustedError } = require('../../../src/v2/errors/LlmErrors');

function makeFakeSdk({ generateContentResponses = [], embedContentResponses = [] }) {
  let genIndex = 0;
  let embedIndex = 0;
  const generateCalls = [];
  const embedCalls = [];

  return {
    generateCalls,
    embedCalls,
    models: {
      generateContent: async (params) => {
        generateCalls.push(params);
        if (genIndex >= generateContentResponses.length) {
          throw new Error('Fake SDK ran out of generateContent responses');
        }
        const resp = generateContentResponses[genIndex++];
        if (resp instanceof Error) throw resp;
        return resp;
      },
      embedContent: async (params) => {
        embedCalls.push(params);
        if (embedIndex >= embedContentResponses.length) {
          throw new Error('Fake SDK ran out of embedContent responses');
        }
        const resp = embedContentResponses[embedIndex++];
        if (resp instanceof Error) throw resp;
        return resp;
      },
    },
  };
}

const testCfg = {
  GEMINI_MODEL: 'gemini-3.5-flash-lite',
  EMBEDDING_MODEL: 'gemini-embedding-001',
  EMBEDDING_DIMS: 768,
  LLM_TIMEOUT_MS: 5000,
  LLM_GENERATE_RPM: 60000,
  LLM_EMBED_RPM: 60000,
};

describe('v2 LLM Client Adapter (createLlmClient)', () => {
  const testSchema = z.object({
    score: z.number(),
    status: z.enum(['pass', 'fail']),
  });

  it('Path (a): parses and returns valid JSON on attempt 1', async () => {
    const loggedCalls = [];
    const fakeRepo = {
      create: async (doc) => {
        loggedCalls.push(doc);
        return doc;
      },
    };

    const sdk = makeFakeSdk({
      generateContentResponses: [
        {
          text: JSON.stringify({ score: 92, status: 'pass' }),
          usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 20 },
        },
      ],
    });

    const client = createLlmClient({
      genai: sdk,
      cfg: testCfg,
      callRepo: fakeRepo,
    });

    const result = await client.generateStructured({
      purpose: 'test_valid',
      system: 'You are a test helper.',
      prompt: 'Score the candidate',
      schema: testSchema,
    });

    expect(result).toEqual({ score: 92, status: 'pass' });
    expect(sdk.generateCalls.length).toBe(1);
    expect('temperature' in sdk.generateCalls[0].config).toBe(false);
    expect(loggedCalls.length).toBe(1);
    expect(loggedCalls[0].ok).toBe(true);
    expect(loggedCalls[0].tokensIn).toBe(15);
    expect(loggedCalls[0].tokensOut).toBe(20);
    expect(loggedCalls[0].attempt).toBe(1);
  });

  it('Path (b): repairs invalid JSON on attempt 2 after appending validation issues', async () => {
    const loggedCalls = [];
    const fakeRepo = {
      create: async (doc) => {
        loggedCalls.push(doc);
        return doc;
      },
    };

    const sdk = makeFakeSdk({
      generateContentResponses: [
        // Attempt 1: score is string instead of number
        {
          text: JSON.stringify({ score: 'ninety-two', status: 'pass' }),
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 15 },
        },
        // Attempt 2: corrected
        {
          text: JSON.stringify({ score: 92, status: 'pass' }),
          usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 15 },
        },
      ],
    });

    const client = createLlmClient({
      genai: sdk,
      cfg: testCfg,
      callRepo: fakeRepo,
    });

    const result = await client.generateStructured({
      purpose: 'test_repair',
      system: 'System instructions',
      prompt: 'Initial prompt text',
      schema: testSchema,
    });

    expect(result).toEqual({ score: 92, status: 'pass' });
    expect(sdk.generateCalls.length).toBe(2);

    // Verify repair prompt appended validation issues
    const repairPrompt = sdk.generateCalls[1].contents;
    expect(repairPrompt).toContain('Initial prompt text');
    expect(repairPrompt).toContain('Your previous JSON failed validation');
    expect(repairPrompt).toContain('score');

    // Both attempts logged
    expect(loggedCalls.length).toBe(2);
    expect(loggedCalls[0].ok).toBe(false);
    expect(loggedCalls[0].attempt).toBe(1);
    expect(loggedCalls[1].ok).toBe(true);
    expect(loggedCalls[1].attempt).toBe(2);
  });

  it('Path (c): throws LlmValidationError when schema validation fails twice', async () => {
    const loggedCalls = [];
    const fakeRepo = {
      create: async (doc) => {
        loggedCalls.push(doc);
        return doc;
      },
    };

    const sdk = makeFakeSdk({
      generateContentResponses: [
        { text: JSON.stringify({ invalidField: true }) },
        { text: JSON.stringify({ invalidField: true }) },
      ],
    });

    const client = createLlmClient({
      genai: sdk,
      cfg: testCfg,
      callRepo: fakeRepo,
    });

    await expect(
      client.generateStructured({
        purpose: 'test_fail_twice',
        system: 'System',
        prompt: 'Prompt',
        schema: testSchema,
      })
    ).rejects.toThrow(LlmValidationError);

    expect(sdk.generateCalls.length).toBe(2);
    expect(loggedCalls.length).toBe(2);
    expect(loggedCalls[0].ok).toBe(false);
    expect(loggedCalls[1].ok).toBe(false);
  });

  it('Path (d): retries transient 503 error and succeeds on second call', async () => {
    const loggedCalls = [];
    const fakeRepo = {
      create: async (doc) => {
        loggedCalls.push(doc);
        return doc;
      },
    };

    const transientError = new Error('Service Unavailable');
    transientError.status = 503;

    const sdk = makeFakeSdk({
      generateContentResponses: [
        transientError,
        { text: JSON.stringify({ score: 88, status: 'pass' }) },
      ],
    });

    const client = createLlmClient({
      genai: sdk,
      cfg: testCfg,
      callRepo: fakeRepo,
    });

    const result = await client.generateStructured({
      purpose: 'test_503_retry',
      system: 'System',
      prompt: 'Prompt',
      schema: testSchema,
    });

    expect(result).toEqual({ score: 88, status: 'pass' });
    expect(sdk.generateCalls.length).toBe(2);
    expect(loggedCalls.length).toBe(1); // Final successful attempt logged
    expect(loggedCalls[0].ok).toBe(true);
  });

  it('Path (e): never retries 400 Bad Request client error and throws immediately', async () => {
    const loggedCalls = [];
    const fakeRepo = {
      create: async (doc) => {
        loggedCalls.push(doc);
        return doc;
      },
    };

    const clientError = new Error('Invalid parameter passed to Gemini');
    clientError.status = 400;

    const sdk = makeFakeSdk({
      generateContentResponses: [clientError],
    });

    const client = createLlmClient({
      genai: sdk,
      cfg: testCfg,
      callRepo: fakeRepo,
    });

    await expect(
      client.generateStructured({
        purpose: 'test_400_no_retry',
        system: 'System',
        prompt: 'Prompt',
        schema: testSchema,
      })
    ).rejects.toThrow();

    // Exactly 1 call attempted, zero retries
    expect(sdk.generateCalls.length).toBe(1);
    expect(loggedCalls.length).toBe(1);
    expect(loggedCalls[0].ok).toBe(false);
    expect(loggedCalls[0].error).toBe('Invalid parameter passed to Gemini');
  });

  it('writes an LlmCall record with ok=false and error text when 503 persists and retries are exhausted', async () => {
    const loggedCalls = [];
    const fakeRepo = {
      create: async (doc) => {
        loggedCalls.push(doc);
        return doc;
      },
    };

    const transientError = new Error('Service Unavailable');
    transientError.status = 503;

    // Fails on attempt 1, 2, and 3 (exhausts retries)
    const sdk = makeFakeSdk({
      generateContentResponses: [transientError, transientError, transientError],
    });

    const client = createLlmClient({
      genai: sdk,
      cfg: testCfg,
      callRepo: fakeRepo,
    });

    await expect(
      client.generateStructured({
        purpose: 'test_503_exhausted',
        system: 'System',
        prompt: 'Prompt',
        schema: testSchema,
      })
    ).rejects.toThrow('Service Unavailable');

    // 1 initial + 2 retries = 3 SDK calls attempted
    expect(sdk.generateCalls.length).toBe(3);
    // Failure must be logged to callRepo with ok: false and error text
    expect(loggedCalls.length).toBe(1);
    expect(loggedCalls[0].ok).toBe(false);
    expect(loggedCalls[0].error).toBe('Service Unavailable');
    expect(loggedCalls[0].attempt).toBe(1);
  });

  it('embed: batches texts and returns L2-normalized vectors', async () => {
    const sdk = makeFakeSdk({
      embedContentResponses: [
        {
          embeddings: [
            { values: [3, 4, 0] },
            { values: [0, 5, 12] },
          ],
        },
      ],
    });

    const client = createLlmClient({
      genai: sdk,
      cfg: testCfg,
      callRepo: { create: async () => {} },
    });

    const vectors = await client.embed(['text one', 'text two']);

    expect(vectors.length).toBe(2);

    // First vector: length of [0.6, 0.8, 0] is 1.0
    expect(vectors[0][0]).toBeCloseTo(0.6, 5);
    expect(vectors[0][1]).toBeCloseTo(0.8, 5);
    expect(vectors[0][2]).toBe(0);

    // Second vector: length of [0, 5/13, 12/13] is 1.0
    expect(vectors[1][0]).toBe(0);
    expect(vectors[1][1]).toBeCloseTo(5 / 13, 5);
    expect(vectors[1][2]).toBeCloseTo(12 / 13, 5);
  });

  it('does not fail LLM call if LlmCall logging fails (best-effort logging)', async () => {
    const failingRepo = {
      create: async () => {
        throw new Error('MongoDB write error');
      },
    };

    const sdk = makeFakeSdk({
      generateContentResponses: [
        { text: JSON.stringify({ score: 99, status: 'pass' }) },
      ],
    });

    const client = createLlmClient({
      genai: sdk,
      cfg: testCfg,
      callRepo: failingRepo,
    });

    // 1. generateStructured succeeds despite repo error
    const result = await client.generateStructured({
      purpose: 'test_db_logging_failure',
      system: 'System',
      prompt: 'Prompt',
      schema: testSchema,
    });
    expect(result).toEqual({ score: 99, status: 'pass' });

    // 2. embed succeeds despite repo error
    const embedSdk = makeFakeSdk({
      embedContentResponses: [{ embeddings: [{ values: [1, 0, 0] }] }],
    });
    const embedClient = createLlmClient({
      genai: embedSdk,
      cfg: testCfg,
      callRepo: failingRepo,
    });
    const embedResult = await embedClient.embed(['test text']);
    expect(embedResult.length).toBe(1);
    expect(embedResult[0]).toEqual([1, 0, 0]);

    // 3. When LLM call fails, callRepo throwing does not mask the original LLM error
    const errorSdk = makeFakeSdk({
      generateContentResponses: [new Error('Gemini API Error 400')],
    });
    const errorClient = createLlmClient({
      genai: errorSdk,
      cfg: testCfg,
      callRepo: failingRepo,
    });
    await expect(
      errorClient.generateStructured({
        purpose: 'test_db_logging_failure_on_error',
        system: 'System',
        prompt: 'Prompt',
        schema: testSchema,
      })
    ).rejects.toThrow('Gemini API Error 400');
  });

  it('respects optional temperature and thinkingLevel parameters', async () => {
    const sdk = makeFakeSdk({
      generateContentResponses: [
        { text: JSON.stringify({ score: 100, status: 'pass' }) },
      ],
    });

    const client = createLlmClient({
      genai: sdk,
      cfg: testCfg,
      callRepo: { create: async () => {} },
    });

    await client.generateStructured({
      purpose: 'test_options',
      system: 'System',
      prompt: 'Prompt',
      schema: testSchema,
      temperature: 0.3,
      thinkingLevel: 'LOW',
    });

    expect(sdk.generateCalls.length).toBe(1);
    const callConfig = sdk.generateCalls[0].config;
    expect(callConfig.temperature).toBe(0.3);
    expect(callConfig.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
  });

  describe('Quota safety & pacing', () => {
    it('paces consecutive calls by enforcing minimum spacing based on RPM (fake timers)', async () => {
      vi.useFakeTimers();
      try {
        const pacer = createPacer(10); // 10 RPM => 6000ms minimum spacing between starts
        const timestamps = [];

        async function executeCall() {
          await pacer();
          timestamps.push(Date.now());
        }

        // Trigger two calls concurrently
        const p1 = executeCall();
        const p2 = executeCall();

        // Advance timers incrementally
        await vi.advanceTimersByTimeAsync(0);
        expect(timestamps.length).toBe(1);

        await vi.advanceTimersByTimeAsync(3000);
        expect(timestamps.length).toBe(1); // Second call still waiting

        await vi.advanceTimersByTimeAsync(3000);
        await Promise.all([p1, p2]);
        expect(timestamps.length).toBe(2);

        // Spacing between start times must be at least 6000ms
        expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(6000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('waits for retryDelay and retries when encountering a per-minute 429 error', async () => {
      const perMinute429 = new Error('429 Rate limit exceeded');
      perMinute429.status = 429;
      perMinute429.errorDetails = [{ retryDelay: '0.1s' }];

      const sdk = makeFakeSdk({
        generateContentResponses: [
          perMinute429,
          { text: JSON.stringify({ score: 95, status: 'pass' }) },
        ],
      });

      const client = createLlmClient({
        genai: sdk,
        cfg: { ...testCfg, LLM_GENERATE_RPM: 600 }, // High RPM so pacing does not delay test
        callRepo: { create: async () => {} },
      });

      const res = await client.generateStructured({
        purpose: 'test_per_minute_429',
        system: 'System',
        prompt: 'Prompt',
        schema: testSchema,
      });

      expect(res).toEqual({ score: 95, status: 'pass' });
      expect(sdk.generateCalls.length).toBe(2);
    });

    it('immediately throws fatal QuotaExhaustedError and NEVER retries on per-day 429', async () => {
      const perDay429 = new Error('Quota exceeded for quota metric GenerateRequestsPerDayPerProjectPerModel');
      perDay429.status = 429;
      perDay429.errorDetails = [
        {
          violations: [
            {
              quotaId: 'GenerateRequestsPerDayPerProjectPerModel',
              description: 'Per-day quota reached for gemini-3.5-flash-lite',
            },
          ],
        },
      ];

      const sdk = makeFakeSdk({
        generateContentResponses: [perDay429],
      });

      const client = createLlmClient({
        genai: sdk,
        cfg: { ...testCfg, LLM_GENERATE_RPM: 600 },
        callRepo: { create: async () => {} },
      });

      await expect(
        client.generateStructured({
          purpose: 'test_per_day_429',
          system: 'System',
          prompt: 'Prompt',
          schema: testSchema,
        })
      ).rejects.toThrow(QuotaExhaustedError);

      // Must have called exactly ONCE without retrying
      expect(sdk.generateCalls.length).toBe(1);
    });
  });
});
