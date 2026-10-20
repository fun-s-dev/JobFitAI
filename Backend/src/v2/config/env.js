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
    GEMINI_MODEL: z.string().min(1).default('gemini-3.5-flash-lite'),
    EMBEDDING_MODEL: z.string().min(1).default('gemini-embedding-001'),
    EMBEDDING_DIMS: z.coerce.number().int().positive().default(768),
    LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    LLM_GENERATE_RPM: z.coerce.number().int().positive().default(10),
    LLM_EMBED_RPM: z.coerce.number().int().positive().default(80),
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
    RATE_LIMIT_VERIFY_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
    RATE_LIMIT_VERIFY_MAX: z.coerce.number().int().positive().default(10),
    RATE_LIMIT_GITHUB_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
    RATE_LIMIT_GITHUB_MAX: z.coerce.number().int().positive().default(10),
    GITHUB_TOKEN: z.string().optional(),
    FRONTEND_URL: z.string().default('http://localhost:5173'),
    TRUST_PROXY_HOPS: z.coerce.number().int().nonnegative().default(1),
    REGISTRATION_OPEN: z.preprocess((val) => val === 'true' || val === true, z.boolean()).default(true),
    INVITE_CODE: z.string().optional(),
    USER_DAILY_VERIFICATIONS: z.coerce.number().int().positive().default(3),
    LLM_DAILY_BUDGET: z.coerce.number().int().positive().default(400),
    EMBEDDING_DAILY_BUDGET: z.coerce.number().int().positive().default(800),
    W_SIM: z.coerce.number().min(0).max(1).default(0.30),
    W_ENT: z.coerce.number().min(0).max(1).default(0.40),
    W_PROJ: z.coerce.number().min(0).max(1).default(0.30),
    W_SIM_NOGH: z.coerce.number().min(0).max(1).default(0.40),
    W_ENT_NOGH: z.coerce.number().min(0).max(1).default(0.60),
    PUPPETEER_NO_SANDBOX: z.preprocess((val) => val === 'true' || val === true, z.boolean()).default(false),
    PDF_RENDERING_ENABLED: z.preprocess((val) => val === 'true' || val === true, z.boolean()).default(true),
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
  )
  .refine(
    (data) => Math.abs(data.W_SIM + data.W_ENT + data.W_PROJ - 1.0) < 0.001,
    {
      message: 'W_SIM + W_ENT + W_PROJ must sum to 1.0',
      path: ['W_SIM'],
    }
  )
  .refine(
    (data) => Math.abs(data.W_SIM_NOGH + data.W_ENT_NOGH - 1.0) < 0.001,
    {
      message: 'W_SIM_NOGH + W_ENT_NOGH must sum to 1.0',
      path: ['W_SIM_NOGH'],
    }
  );

/**
 * Pure function that validates an environment dictionary and returns a frozen config object.
 * Throws ConfigError on validation failure. Never calls process.exit.
 */
function loadConfig(envObject = {}) {
  const isProd = envObject.NODE_ENV === 'production';
  const preparedEnv = {
    ...envObject,
    PDF_RENDERING_ENABLED:
      envObject.PDF_RENDERING_ENABLED !== undefined
        ? envObject.PDF_RENDERING_ENABLED
        : !isProd,
    REGISTRATION_OPEN:
      envObject.REGISTRATION_OPEN !== undefined
        ? envObject.REGISTRATION_OPEN
        : !isProd,
  };
  const result = envSchema.safeParse(preparedEnv);
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
