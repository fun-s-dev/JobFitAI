import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLlmClient } = require('../../../src/v2/adapters/llmClient');

describe('EmbeddingCache & llmClient.embedTexts', () => {
  let fakeGenai;
  let fakeCacheRepo;
  let fakeCallRepo;
  let cacheStore;
  let embedContentCalls;

  beforeEach(() => {
    cacheStore = new Map();
    embedContentCalls = 0;

    fakeCallRepo = {
      async create() {},
    };

    fakeCacheRepo = {
      async find(query) {
        const keys = query?.key?.$in || [];
        const results = [];
        for (const k of keys) {
          if (cacheStore.has(k)) {
            results.push(cacheStore.get(k));
          }
        }
        return {
          lean: async () => results,
        };
      },
      async insertMany(docs) {
        for (const doc of docs) {
          if (cacheStore.has(doc.key)) {
            const err = new Error('E11000 duplicate key error collection');
            err.code = 11000;
            throw err;
          }
          cacheStore.set(doc.key, { ...doc });
        }
        return docs;
      },
    };

    fakeGenai = {
      models: {
        async embedContent({ contents }) {
          embedContentCalls++;
          const items = Array.isArray(contents) ? contents : [contents];
          return {
            embeddings: items.map(() => ({
              // 4-dimensional unnormalized vector
              values: [1, 2, 2, 0], // norm = 3 -> normalized should be [1/3, 2/3, 2/3, 0]
            })),
          };
        },
      },
    };
  });

  it('embeds texts on first run and returns stats with misses and apiCalls', async () => {
    const client = createLlmClient({
      genai: fakeGenai,
      cacheRepo: fakeCacheRepo,
      callRepo: fakeCallRepo,
      cfg: { LLM_CONCURRENCY: 2 },
    });

    const texts = ['First chunk', 'Second chunk', 'Third chunk'];
    const res = await client.embedTexts(texts);

    expect(res.stats.misses).toBe(3);
    expect(res.stats.hits).toBe(0);
    expect(res.stats.apiCalls).toBe(1);
    expect(res.vectors).toHaveLength(3);
    expect(embedContentCalls).toBe(1);

    // Assert normalized on write
    for (const vec of res.vectors) {
      expect(vec[0]).toBeCloseTo(1 / 3, 5);
      expect(vec[1]).toBeCloseTo(2 / 3, 5);
      expect(vec[2]).toBeCloseTo(2 / 3, 5);
    }
  });

  it('second run with same texts makes ZERO embedding API calls (asserted via stats and call count)', async () => {
    const client = createLlmClient({
      genai: fakeGenai,
      cacheRepo: fakeCacheRepo,
      callRepo: fakeCallRepo,
      cfg: { LLM_CONCURRENCY: 2 },
    });

    const texts = ['Built REST API', 'Engineered database schema'];

    // First run: cache misses
    const run1 = await client.embedTexts(texts);
    expect(run1.stats.apiCalls).toBe(1);
    expect(embedContentCalls).toBe(1);

    // Second run: cache hits
    const run2 = await client.embedTexts(texts);
    expect(run2.stats.hits).toBe(2);
    expect(run2.stats.misses).toBe(0);
    expect(run2.stats.apiCalls).toBe(0);
    expect(embedContentCalls).toBe(1); // STILL 1: Zero new API calls!
  });

  it('deduplicates identical texts inside one batch so each is embedded once', async () => {
    let embeddedBatchSizes = [];
    fakeGenai.models.embedContent = async ({ contents }) => {
      embedContentCalls++;
      embeddedBatchSizes.push(contents.length);
      return {
        embeddings: contents.map(() => ({ values: [1, 0, 0, 0] })),
      };
    };

    const client = createLlmClient({
      genai: fakeGenai,
      cacheRepo: fakeCacheRepo,
      callRepo: fakeCallRepo,
    });

    // 4 items, but 3 are identical duplicates
    const texts = ['Duplicate text', 'Duplicate text', 'Duplicate text', 'Unique text'];
    const res = await client.embedTexts(texts);

    expect(res.vectors).toHaveLength(4);
    // Should have sent only 2 unique texts to Gemini
    expect(embeddedBatchSizes[0]).toBe(2);
    expect(embedContentCalls).toBe(1);
  });

  it('handles parallel writes with duplicate-key error (code 11000) gracefully without crashing', async () => {
    // Simulate race condition where insertMany throws duplicate key error 11000
    fakeCacheRepo.insertMany = async () => {
      const err = new Error('E11000 duplicate key error collection: index key dup');
      err.code = 11000;
      throw err;
    };

    const client = createLlmClient({
      genai: fakeGenai,
      cacheRepo: fakeCacheRepo,
      callRepo: fakeCallRepo,
    });

    // Should succeed and return vectors without throwing
    const res = await client.embedTexts(['Parallel text 1']);
    expect(res.vectors).toHaveLength(1);
    expect(res.stats.misses).toBe(1);
  });

  it('backward-compatible embed() method still works and returns vectors directly', async () => {
    const client = createLlmClient({
      genai: fakeGenai,
      cacheRepo: fakeCacheRepo,
      callRepo: fakeCallRepo,
    });

    const vectors = await client.embed(['Legacy embed call']);
    expect(Array.isArray(vectors)).toBe(true);
    expect(vectors).toHaveLength(1);
  });

  it('defines unique index on key and TTL expireAfterSeconds index on createdAt', () => {
    const EmbeddingCache = require('../../../src/v2/models/embeddingCache.model');
    const indexes = EmbeddingCache.schema.indexes();

    // 1. Unique index on key
    const keyIndex = indexes.find(([fields]) => fields.key === 1);
    expect(keyIndex).toBeDefined();
    expect(keyIndex[1].unique).toBe(true);

    // 2. TTL index on createdAt
    const ttlIndex = indexes.find(([fields]) => fields.createdAt === 1);
    expect(ttlIndex).toBeDefined();
    expect(ttlIndex[1].expireAfterSeconds).toBe(90 * 86400);
  });

  it('tracks cacheErrors and logs warning once with error name when cache lookup fails', async () => {
    const warnings = [];
    const testLogger = {
      warn: (obj, msg) => warnings.push({ obj, msg }),
      info: () => {},
      error: () => {},
    };

    fakeCacheRepo.find = () => {
      const err = new TypeError('Simulated cache network failure');
      err.name = 'MongoNetworkTimeoutError';
      throw err;
    };

    const client = createLlmClient({
      genai: fakeGenai,
      cacheRepo: fakeCacheRepo,
      callRepo: fakeCallRepo,
      logger: testLogger,
    });

    const res = await client.embedTexts(['Text with broken cache']);
    // Call succeeds without breaking
    expect(res.vectors).toHaveLength(1);
    expect(res.stats.misses).toBe(1);
    expect(res.stats.apiCalls).toBe(1);
    expect(res.stats.cacheErrors).toBe(1);

    // Warning logged once with error name only
    expect(warnings).toHaveLength(1);
    expect(warnings[0].obj).toEqual({ errorName: 'MongoNetworkTimeoutError' });
    expect(warnings[0].msg).toBe('Failed to look up EmbeddingCache');
  });
});

