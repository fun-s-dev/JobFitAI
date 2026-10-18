const crypto = require('node:crypto');
const { GoogleGenAI } = require('@google/genai');
const { z } = require('zod');
const { cleanSchemaForGemini } = require('../utils/cleanSchema');
const { withTimeout, withRetry, isTransientError } = require('../utils/resilience');
const { normalizeVector } = require('../core/normalize');
const { vectorToBuffer, bufferToVector } = require('../core/vectorBuffer');
const { createLimiter } = require('../utils/limiter');
const { LlmValidationError, LlmClientError } = require('../errors/LlmErrors');
const LlmCall = require('../models/llmCall.model');
const EmbeddingCache = require('../models/embeddingCache.model');
const { logger: defaultLogger } = require('../utils/logger');

// [ASSUMED] Batch limit of 100 texts per embedContent call based on Google API REST documentation (not typed as a constant in SDK).
const EMBED_BATCH_SIZE = 100;

/**
 * Creates an asynchronous pacer that guarantees a minimum interval (60000 / rpm)
 * between the start of consecutive calls, shared across all callers.
 */
function createPacer(rpm) {
  const minSpacingMs = Math.ceil(60000 / Math.max(1, rpm));
  let lastCallStartTime = 0;
  let queue = Promise.resolve();

  return function pace() {
    const run = async () => {
      const now = Date.now();
      const waitMs = Math.max(0, lastCallStartTime + minSpacingMs - now);
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      lastCallStartTime = Date.now();
    };
    queue = queue.then(run, run);
    return queue;
  };
}

function createLlmClient({
  genai,
  cfg = {},
  logger = defaultLogger,
  callRepo = LlmCall,
  cacheRepo = EmbeddingCache,
} = {}) {
  const client =
    genai ||
    new GoogleGenAI({
      apiKey: cfg.GOOGLE_GENAI_API_KEY || process.env.GOOGLE_GENAI_API_KEY,
    });

  const model = cfg.GEMINI_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const embeddingModel = cfg.EMBEDDING_MODEL || process.env.EMBEDDING_MODEL || 'gemini-embedding-001';
  const embeddingDims = cfg.EMBEDDING_DIMS || 768;
  const timeoutMs = cfg.LLM_TIMEOUT_MS || 30000;
  const concurrency = cfg.LLM_CONCURRENCY || 5;
  const limiter = createLimiter(concurrency);

  const generateRpm = Number(cfg.LLM_GENERATE_RPM || process.env.LLM_GENERATE_RPM || 10);
  const embedRpm = Number(cfg.LLM_EMBED_RPM || process.env.LLM_EMBED_RPM || 80);
  const generatePacer = createPacer(generateRpm);
  const embedPacer = createPacer(embedRpm);

  async function logCallSafely(data) {
    try {
      if (callRepo && typeof callRepo.create === 'function') {
        await callRepo.create(data);
      }
    } catch (err) {
      if (logger && typeof logger.error === 'function') {
        logger.error({ err: err.message, purpose: data.purpose }, 'Failed to record LlmCall audit log');
      }
    }
  }

  /**
   * Generates structured JSON matching a Zod schema with retry, backoff, and one repair retry.
   */
  async function generateStructured({
    purpose = 'generate_structured',
    system,
    prompt,
    schema,
    temperature,
    thinkingLevel = 'LOW',
    user = null,
    runId = null,
    requestId = null,
  }) {
    if (!schema) {
      throw new Error('A Zod schema is required for generateStructured');
    }

    const responseSchema = cleanSchemaForGemini(z.toJSONSchema(schema));
    let currentPrompt = prompt;
    let lastIssues = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const t0 = Date.now();
      let callResult = null;

      try {
        const config = {
          systemInstruction: system,
          responseMimeType: 'application/json',
          responseSchema,
        };

        if (temperature !== undefined) {
          config.temperature = temperature;
        }

        if (thinkingLevel) {
          config.thinkingConfig = { thinkingLevel };
        }

        callResult = await withRetry(
          async () => {
            await generatePacer();
            return withTimeout(
              async ({ signal }) => {
                config.abortSignal = signal;
                return client.models.generateContent({
                  model,
                  contents: currentPrompt,
                  config,
                });
              },
              timeoutMs
            );
          },
          {
            retries: 2,
            minTimeout: 500,
            factor: 2,
            randomize: true,
            shouldRetry: isTransientError,
            logger,
            purpose,
          }
        );

        let parsedJson;
        try {
          parsedJson = JSON.parse(callResult.text);
        } catch (jsonErr) {
          throw new LlmClientError(`Failed to parse LLM response as JSON: ${jsonErr.message}`, jsonErr);
        }

        const validation = schema.safeParse(parsedJson);
        const ms = Date.now() - t0;
        const tokensIn = callResult.usageMetadata?.promptTokenCount || 0;
        const tokensOut = callResult.usageMetadata?.candidatesTokenCount || 0;

        if (validation.success) {
          await logCallSafely({
            user,
            runId,
            requestId,
            purpose,
            model,
            attempt,
            ok: true,
            ms,
            tokensIn,
            tokensOut,
            costEstimate: 0,
            error: null,
          });
          return validation.data;
        }

        // Schema validation failed
        lastIssues = validation.error.issues;
        await logCallSafely({
          user,
          runId,
          requestId,
          purpose,
          model,
          attempt,
          ok: false,
          ms,
          tokensIn,
          tokensOut,
          costEstimate: 0,
          error: 'Schema validation failed',
        });

        if (attempt === 1) {
          const issueSnippet = JSON.stringify(lastIssues).slice(0, 800);
          currentPrompt = `${prompt}\n\nYour previous JSON failed validation:\n${issueSnippet}\nReturn corrected JSON matching the schema only.`;
        }
      } catch (err) {
        const ms = Date.now() - t0;

        await logCallSafely({
          user,
          runId,
          requestId,
          purpose,
          model,
          attempt,
          ok: false,
          ms,
          tokensIn: 0,
          tokensOut: 0,
          costEstimate: 0,
          error: err.message || 'LLM call failed',
        });

        throw err;
      }
    }

    throw new LlmValidationError(purpose, lastIssues);
  }

  /**
   * Embeds an array of texts with content-hashed caching, deduplication,
   * bounded concurrency, and L2 unit-normalization on write.
   *
   * @param {string|string[]} texts
   * @param {object} options
   * @returns {Promise<{ vectors: number[][], stats: { hits: number, misses: number, apiCalls: number } }>}
   */
  async function embedTexts(texts, { user = null, runId = null, requestId = null, purpose = 'embed' } = {}) {
    const rawList = Array.isArray(texts) ? texts : [texts];
    const textList = rawList.filter((t) => typeof t === 'string' && t.trim().length > 0);

    if (textList.length === 0) {
      return {
        vectors: [],
        stats: { hits: 0, misses: 0, apiCalls: 0, cacheErrors: 0 },
      };
    }

    const taskType = 'SEMANTIC_SIMILARITY';
    let cacheErrors = 0;
    let hasLoggedCacheWarning = false;

    // Compute key for each input text: sha256(model|dims|taskType|text)
    const itemKeys = textList.map((t) => {
      return crypto
        .createHash('sha256')
        .update(`${embeddingModel}|${embeddingDims}|${taskType}|${t}`)
        .digest('hex');
    });

    const keyToVectorMap = new Map();
    const uniqueKeys = Array.from(new Set(itemKeys));

    // 1. Look up cached vectors in cacheRepo
    if (cacheRepo && typeof cacheRepo.find === 'function') {
      try {
        const query = cacheRepo.find({ key: { $in: uniqueKeys } });
        let cachedDocs = typeof query?.lean === 'function' ? await query.lean() : await query;
        if (cachedDocs && typeof cachedDocs.lean === 'function') {
          cachedDocs = await cachedDocs.lean();
        }
        if (Array.isArray(cachedDocs)) {
          for (const doc of cachedDocs) {
            if (doc && doc.key && doc.vector) {
              try {
                const vectorArray = bufferToVector(doc.vector);
                keyToVectorMap.set(doc.key, vectorArray);
              } catch (docErr) {
                cacheErrors++;
                if (!hasLoggedCacheWarning && logger && typeof logger.warn === 'function') {
                  hasLoggedCacheWarning = true;
                  logger.warn({ errorName: docErr.name || 'Error' }, 'Failed to decode cached vector');
                }
              }
            }
          }
        }
      } catch (cacheLookupErr) {
        cacheErrors++;
        if (!hasLoggedCacheWarning && logger && typeof logger.warn === 'function') {
          hasLoggedCacheWarning = true;
          logger.warn({ errorName: cacheLookupErr.name || 'Error' }, 'Failed to look up EmbeddingCache');
        }
      }
    }

    // 2. Identify missing unique texts
    const missingItems = [];
    const seenMissingKeys = new Set();

    for (let i = 0; i < textList.length; i++) {
      const key = itemKeys[i];
      const text = textList[i];
      if (!keyToVectorMap.has(key) && !seenMissingKeys.has(key)) {
        seenMissingKeys.add(key);
        missingItems.push({ key, text });
      }
    }

    let hits = 0;
    let misses = 0;
    for (const key of itemKeys) {
      if (keyToVectorMap.has(key)) {
        hits++;
      } else {
        misses++;
      }
    }

    let apiCalls = 0;

    // 3. Batch and embed misses under bounded concurrency
    if (missingItems.length > 0) {
      const batches = [];
      for (let i = 0; i < missingItems.length; i += EMBED_BATCH_SIZE) {
        batches.push(missingItems.slice(i, i + EMBED_BATCH_SIZE));
      }

      const batchPromises = batches.map((batch) =>
        limiter(async () => {
          const contents = batch.map((item) => item.text);
          const t0 = Date.now();
          apiCalls++;

          try {
            const response = await withRetry(
              async () => {
                await embedPacer();
                return withTimeout(
                  async ({ signal }) => {
                    return client.models.embedContent({
                      model: embeddingModel,
                      contents,
                      config: {
                        taskType,
                        outputDimensionality: embeddingDims,
                        abortSignal: signal,
                      },
                    });
                  },
                  timeoutMs
                );
              },
              {
                retries: 2,
                minTimeout: 500,
                factor: 2,
                randomize: true,
                shouldRetry: isTransientError,
                logger,
                purpose,
              }
            );

            const ms = Date.now() - t0;
            let rawVectors = [];
            if (response.embeddings && Array.isArray(response.embeddings)) {
              rawVectors = response.embeddings.map((e) => e.values || []);
            } else if (response.embedding && response.embedding.values) {
              rawVectors = [response.embedding.values];
            }

            // Normalize vectors on write
            const normalizedVectors = rawVectors.map((v) => normalizeVector(v));

            // Write newly embedded vectors to cache
            const docsToInsert = [];
            for (let b = 0; b < batch.length; b++) {
              const { key } = batch[b];
              const vec = normalizedVectors[b] || [];
              keyToVectorMap.set(key, vec);

              docsToInsert.push({
                key,
                vector: vectorToBuffer(vec),
                dims: embeddingDims,
                model: embeddingModel,
                taskType,
                createdAt: new Date(),
              });
            }

            if (cacheRepo && typeof cacheRepo.insertMany === 'function' && docsToInsert.length > 0) {
              try {
                await cacheRepo.insertMany(docsToInsert, { ordered: false });
              } catch (insertErr) {
                // Ignore code 11000 duplicate-key error (parallel verifications)
                const isDupKey =
                  insertErr.code === 11000 ||
                  insertErr.message?.includes('11000') ||
                  (Array.isArray(insertErr.writeErrors) &&
                    insertErr.writeErrors.every((we) => we.code === 11000));
                if (!isDupKey && logger && typeof logger.warn === 'function') {
                  logger.warn({ err: insertErr.message }, 'Failed to persist docs into EmbeddingCache');
                }
              }
            }

            await logCallSafely({
              user,
              runId,
              requestId,
              purpose,
              model: embeddingModel,
              attempt: 1,
              ok: true,
              ms,
              tokensIn: 0,
              tokensOut: 0,
              costEstimate: 0,
              error: null,
            });
          } catch (err) {
            const ms = Date.now() - t0;
            await logCallSafely({
              user,
              runId,
              requestId,
              purpose,
              model: embeddingModel,
              attempt: 1,
              ok: false,
              ms,
              tokensIn: 0,
              tokensOut: 0,
              costEstimate: 0,
              error: err.message,
            });
            throw err;
          }
        })
      );

      await Promise.all(batchPromises);
    }

    // Reconstruct vectors in original text order
    const orderedVectors = itemKeys.map((key) => keyToVectorMap.get(key) || []);

    return {
      vectors: orderedVectors,
      stats: {
        hits,
        misses,
        apiCalls,
        cacheErrors,
      },
    };
  }

  /**
   * Backward-compatible helper returning pure vectors.
   */
  async function embed(texts, options = {}) {
    const res = await embedTexts(texts, options);
    return res.vectors;
  }

  return {
    generateStructured,
    embed,
    embedTexts,
  };
}

module.exports = {
  createLlmClient,
  createPacer,
};
