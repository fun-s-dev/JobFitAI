const { z } = require('zod');

class ConfigError extends Error {
  constructor(issues) {
    const formatted = issues
      .map((issue) => {
        const path = issue.path && issue.path.length > 0 ? issue.path.join('.') : 'config';
        return `  - [${path}]: ${issue.message}`;
      })
      .join('\n');
    super(`Configuration validation failed with ${issues.length} error(s):\n${formatted}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    GOOGLE_GENAI_API_KEY: z.string().min(1, 'GOOGLE_GENAI_API_KEY is required'),
    GEMINI_MODEL: z.string().min(1).default('gemini-3-flash-preview'),
    EMBEDDING_MODEL: z.string().min(1).default('gemini-embedding-001'),
    EMBEDDING_DIMS: z.coerce.number().int().positive().default(768),
    LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    THRESHOLD_VERIFIED: z.coerce.number().min(0).max(1).default(0.8),
    THRESHOLD_REVIEW: z.coerce.number().min(0).max(1).default(0.5),
    SIM_LO: z.coerce.number().min(-1).max(1).default(0.5),
    SIM_HI: z.coerce.number().min(-1).max(1).default(0.9),
    EMBEDDING_CACHE_TTL_DAYS: z.coerce.number().int().positive().default(90),
    LLM_CONCURRENCY: z.coerce.number().int().positive().default(5),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    RATE_LIMIT_DRAFT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
    RATE_LIMIT_DRAFT_MAX: z.coerce.number().int().positive().default(10),
    PUPPETEER_NO_SANDBOX: z.preprocess((val) => val === 'true' || val === true, z.boolean()).default(false),
    ENTAILMENT_THINKING_LEVEL: z.enum(['LOW', 'MEDIUM', 'HIGH', 'OFF']).default('LOW'),
    ENTAILMENT_SCORE_YES: z.coerce.number().min(0).max(1).default(1.0),
    ENTAILMENT_SCORE_PARTIAL: z.coerce.number().min(0).max(1).default(0.5),
    ENTAILMENT_SCORE_NO: z.coerce.number().min(0).max(1).default(0.0),
    QUOTE_GROUNDING_THRESHOLD: z.coerce.number().min(0).max(1).default(0.90),
    MAX_EVIDENCE_CHUNKS: z.coerce.number().int().positive().default(3),
    MAX_CHUNK_CHARS: z.coerce.number().int().positive().default(500),
  })

  .refine(
    (data) => data.THRESHOLD_VERIFIED > data.THRESHOLD_REVIEW,
    {
      message: 'THRESHOLD_VERIFIED must be greater than THRESHOLD_REVIEW',
      path: ['THRESHOLD_VERIFIED'],
    }
  )
  .refine(
    (data) => data.SIM_LO < data.SIM_HI,
    {
      message: 'SIM_LO must be strictly less than SIM_HI',
      path: ['SIM_LO'],
    }
  );

/**
 * Pure function that validates an environment dictionary and returns a frozen config object.
 * Throws ConfigError on validation failure. Never calls process.exit.
 */
function loadConfig(envObject = {}) {
  const result = envSchema.safeParse(envObject);
  if (!result.success) {
    throw new ConfigError(result.error.issues);
  }
  return Object.freeze(result.data);
}

// Lazy getter for default process.env config in application runtime
let _cfg = null;
function getCfg() {
  if (!_cfg) {
    _cfg = loadConfig(process.env);
  }
  return _cfg;
}

module.exports = {
  loadConfig,
  ConfigError,
  getCfg,
};
