const { GoogleGenAI } = require('@google/genai');
const { z } = require('zod');
const { cleanSchemaForGemini } = require('../utils/cleanSchema');
const { withTimeout, withRetry, isTransientError } = require('../utils/resilience');
const { normalizeVector } = require('../core/normalize');
const { LlmValidationError, LlmClientError } = require('../errors/LlmErrors');
const LlmCall = require('../models/llmCall.model');
const { logger: defaultLogger } = require('../utils/logger');

// [ASSUMED] Batch limit of 100 texts per embedContent call based on Google API REST documentation (not typed as a constant in SDK).
const EMBED_BATCH_SIZE = 100;

function createLlmClient({
  genai,
  cfg = {},
  logger = defaultLogger,
  callRepo = LlmCall,
} = {}) {
  const client =
    genai ||
    new GoogleGenAI({
      apiKey: cfg.GOOGLE_GENAI_API_KEY || process.env.GOOGLE_GENAI_API_KEY,
    });

  const model = cfg.GEMINI_MODEL || process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
  const embeddingModel = cfg.EMBEDDING_MODEL || process.env.EMBEDDING_MODEL || 'gemini-embedding-001';
  const embeddingDims = cfg.EMBEDDING_DIMS || 768;
  const timeoutMs = cfg.LLM_TIMEOUT_MS || 30000;

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
   * Batched text embedding with L2 normalization.
   */
  async function embed(texts, { user = null, runId = null, purpose = 'embed' } = {}) {
    const textList = Array.isArray(texts) ? texts : [texts];
    if (textList.length === 0) return [];

    const allVectors = [];

    for (let i = 0; i < textList.length; i += EMBED_BATCH_SIZE) {
      const batch = textList.slice(i, i + EMBED_BATCH_SIZE);
      const t0 = Date.now();

      try {
        const response = await withRetry(
          async () => {
            return withTimeout(
              async ({ signal }) => {
                return client.models.embedContent({
                  model: embeddingModel,
                  contents: batch,
                  config: {
                    taskType: 'SEMANTIC_SIMILARITY',
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

        let batchVectors = [];
        if (response.embeddings && Array.isArray(response.embeddings)) {
          batchVectors = response.embeddings.map((e) => normalizeVector(e.values || []));
        } else if (response.embedding && response.embedding.values) {
          batchVectors = [normalizeVector(response.embedding.values)];
        }

        allVectors.push(...batchVectors);

        await logCallSafely({
          user,
          runId,
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
    }

    return allVectors;
  }

  return {
    generateStructured,
    embed,
  };
}

module.exports = {
  createLlmClient,
};
