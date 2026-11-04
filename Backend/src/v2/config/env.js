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

// `VAR=` in a .env file arrives as '' - treat it as "not set"
function emptyAsUndefined(schema) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema);
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
    RATE_LIMIT_REPORT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
    RATE_LIMIT_REPORT_MAX: z.coerce.number().int().positive().default(10),
    RATE_LIMIT_LOGIN_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
    RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(10),
    RATE_LIMIT_REGISTER_WINDOW_MS: z.coerce.number().int().positive().default(60 * 60 * 1000),
    RATE_LIMIT_REGISTER_MAX: z.coerce.number().int().positive().default(10),
    USER_DAILY_REPORTS: z.coerce.number().int().positive().default(10),
    RATE_LIMIT_EXPORT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
    RATE_LIMIT_EXPORT_MAX: z.coerce.number().int().positive().default(20),
    PDF_RENDER_CONCURRENCY: z.coerce.number().int().positive().default(1),
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
    // GitHub Connect (GitHub App user authorization). All four are optional as a group:
    // when none is set the feature reports "not configured"; when any is set all must be valid.
    GITHUB_APP_CLIENT_ID: emptyAsUndefined(z.string().min(1).optional()),
    GITHUB_APP_CLIENT_SECRET: emptyAsUndefined(z.string().min(1).optional()),
    GITHUB_APP_CALLBACK_URL: emptyAsUndefined(z.string().url().optional()),
    GITHUB_TOKEN_ENC_KEY: emptyAsUndefined(z.string().optional()),
    RATE_LIMIT_GITHUB_CONNECT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
    RATE_LIMIT_GITHUB_CONNECT_MAX: z.coerce.number().int().positive().default(30),
    USER_DAILY_GITHUB_ANALYSES: z.coerce.number().int().positive().default(20),
    // Repository ranking: how many repositories are analysed and how many are pre-selected
    USER_DAILY_RANKINGS: z.coerce.number().int().positive().default(5),
    RANKING_MAX_REPOS: z.coerce.number().int().positive().max(30).default(15),
    RANKING_TOP_N: z.coerce.number().int().positive().max(6).default(4),
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
  )
  .superRefine((data, ctx) => {
    const groupKeys = [
      'GITHUB_APP_CLIENT_ID',
      'GITHUB_APP_CLIENT_SECRET',
      'GITHUB_APP_CALLBACK_URL',
      'GITHUB_TOKEN_ENC_KEY',
    ];
    const anySet = groupKeys.some((k) => data[k] !== undefined);
    if (!anySet) return;

    for (const key of groupKeys) {
      if (data[key] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is required when any GitHub Connect variable is set`,
        });
      }
    }

    if (data.GITHUB_TOKEN_ENC_KEY !== undefined && Buffer.from(data.GITHUB_TOKEN_ENC_KEY, 'base64').length !== 32) {
      ctx.addIssue({
        code: 'custom',
        path: ['GITHUB_TOKEN_ENC_KEY'],
        message: 'GITHUB_TOKEN_ENC_KEY must be a base64-encoded 32-byte key',
      });
    }

    if (data.GITHUB_APP_CALLBACK_URL !== undefined) {
      let parsed = null;
      try {
        parsed = new URL(data.GITHUB_APP_CALLBACK_URL);
      } catch {
        parsed = null;
      }
      const isLocalHttp = parsed && parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname);
      const isHttps = parsed && parsed.protocol === 'https:';
      if (!parsed || !(isHttps || isLocalHttp)) {
        ctx.addIssue({
          code: 'custom',
          path: ['GITHUB_APP_CALLBACK_URL'],
          message: 'GITHUB_APP_CALLBACK_URL must be https (or http on localhost)',
        });
      } else if (parsed.pathname !== '/api/v2/github/connect/callback' || parsed.search || parsed.hash) {
        ctx.addIssue({
          code: 'custom',
          path: ['GITHUB_APP_CALLBACK_URL'],
          message: 'GITHUB_APP_CALLBACK_URL must end with /api/v2/github/connect/callback and have no query',
        });
      }
    }
  });

/** True when all GitHub Connect variables are present (the schema guarantees they are valid together). */
function isGitHubConnectConfigured(cfg) {
  return Boolean(
    cfg &&
      cfg.GITHUB_APP_CLIENT_ID &&
      cfg.GITHUB_APP_CLIENT_SECRET &&
      cfg.GITHUB_APP_CALLBACK_URL &&
      cfg.GITHUB_TOKEN_ENC_KEY
  );
}

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
  isGitHubConnectConfigured,
};
