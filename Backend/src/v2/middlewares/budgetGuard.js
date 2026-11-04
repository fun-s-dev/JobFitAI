const { getCfg } = require('../config/env');
const { getMidnightPacific, checkBudget, BUDGET_TYPES } = require('../core/budgetGuards');
const VerificationRun = require('../models/verificationRun.model');
const LlmCall = require('../models/llmCall.model');
const Job = require('../models/job');

// Purpose label written to llmcalls by the V1 interview-report service (must stay in sync).
const INTERVIEW_REPORT_PURPOSE = 'interview_report';

/**
 * Creates budget guard middlewares with dependency injection for testing.
 */
function createBudgetGuardMiddleware({
  verificationRunModel = VerificationRun,
  llmCallModel = LlmCall,
  jobModel = Job,
  configGetter = getCfg,
  getNow = () => new Date(),
} = {}) {
  async function guardUserVerifications(req, res, next) {
    try {
      const cfg = configGetter();
      const userId = req.user ? (req.user._id || req.user.id) : null;
      if (!userId) return next();

      const midnight = getMidnightPacific(getNow());
      const count = await verificationRunModel.countDocuments({
        user: userId,
        createdAt: { $gte: midnight },
      });

      const maxLimit = process.env.USER_DAILY_VERIFICATIONS !== undefined
        ? parseInt(process.env.USER_DAILY_VERIFICATIONS, 10)
        : cfg.USER_DAILY_VERIFICATIONS;

      const result = checkBudget({
        type: BUDGET_TYPES.USER_VERIFICATIONS,
        currentCount: count,
        maxLimit,
      });

      if (!result.allowed) {
        const requestId = req.id || req.headers['x-request-id'] || 'unknown';
        return res.status(429).json({
          code: 'DAILY_BUDGET_REACHED',
          error: {
            code: 'DAILY_BUDGET_REACHED',
            message: result.error.message,
            requestId,
          },
          message: result.error.message,
        });
      }

      next();
    } catch (err) {
      next(err);
    }
  }

  /**
   * Per-user daily cap on V1 interview-report AI requests.
   * Counts llmcalls rows (every attempt, successful or not) for this user and purpose since
   * Pacific midnight, so repeated failing attempts cannot bypass the cap.
   */
  async function guardUserDailyReports(req, res, next) {
    try {
      const cfg = configGetter();
      const userId = req.user ? (req.user._id || req.user.id) : null;
      if (!userId) return next();

      const midnight = getMidnightPacific(getNow());
      const count = await llmCallModel.countDocuments({
        user: userId,
        purpose: INTERVIEW_REPORT_PURPOSE,
        createdAt: { $gte: midnight },
      });

      const maxLimit = process.env.USER_DAILY_REPORTS !== undefined
        ? parseInt(process.env.USER_DAILY_REPORTS, 10)
        : cfg.USER_DAILY_REPORTS;

      const result = checkBudget({
        type: BUDGET_TYPES.USER_REPORTS,
        currentCount: count,
        maxLimit,
      });

      if (!result.allowed) {
        const requestId = req.id || req.headers['x-request-id'] || 'unknown';
        return res.status(429).json({
          code: 'DAILY_BUDGET_REACHED',
          error: {
            code: 'DAILY_BUDGET_REACHED',
            message: result.error.message,
            requestId,
          },
          message: result.error.message,
        });
      }

      next();
    } catch (err) {
      next(err);
    }
  }

  /**
   * Per-user daily cap on GitHub repository analyses (counts github_analysis jobs since Pacific
   * midnight, whatever their outcome). Protects GitHub API rate limits and server work; analysis itself
   * does not call Gemini.
   */
  async function guardUserDailyGithubAnalyses(req, res, next) {
    try {
      const cfg = configGetter();
      const userId = req.user ? (req.user._id || req.user.id) : null;
      if (!userId) return next();

      const midnight = getMidnightPacific(getNow());
      const count = await jobModel.countDocuments({
        user: userId,
        type: 'github_analysis',
        createdAt: { $gte: midnight },
      });

      const maxLimit = process.env.USER_DAILY_GITHUB_ANALYSES !== undefined
        ? parseInt(process.env.USER_DAILY_GITHUB_ANALYSES, 10)
        : cfg.USER_DAILY_GITHUB_ANALYSES;

      const result = checkBudget({
        type: BUDGET_TYPES.USER_GITHUB_ANALYSES,
        currentCount: count,
        maxLimit,
      });

      if (!result.allowed) {
        const requestId = req.id || req.headers['x-request-id'] || 'unknown';
        return res.status(429).json({
          code: 'DAILY_BUDGET_REACHED',
          error: {
            code: 'DAILY_BUDGET_REACHED',
            message: result.error.message,
            requestId,
          },
          message: result.error.message,
        });
      }

      next();
    } catch (err) {
      next(err);
    }
  }

  async function guardLlmGenerationBudget(req, res, next) {
    try {
      const cfg = configGetter();
      const midnight = getMidnightPacific(getNow());
      const model = cfg.GEMINI_MODEL;
      const count = await llmCallModel.countDocuments({
        model,
        createdAt: { $gte: midnight },
      });

      const maxLimit = process.env.LLM_DAILY_BUDGET !== undefined
        ? parseInt(process.env.LLM_DAILY_BUDGET, 10)
        : cfg.LLM_DAILY_BUDGET;

      const result = checkBudget({
        type: BUDGET_TYPES.LLM_GENERATION,
        currentCount: count,
        maxLimit,
      });

      if (!result.allowed) {
        const requestId = req.id || req.headers['x-request-id'] || 'unknown';
        return res.status(429).json({
          code: 'DAILY_BUDGET_REACHED',
          error: {
            code: 'DAILY_BUDGET_REACHED',
            message: result.error.message,
            requestId,
          },
          message: result.error.message,
        });
      }

      next();
    } catch (err) {
      next(err);
    }
  }

  async function guardEmbeddingBudget(req, res, next) {
    try {
      const cfg = configGetter();
      const midnight = getMidnightPacific(getNow());
      const model = cfg.EMBEDDING_MODEL;
      const count = await llmCallModel.countDocuments({
        model,
        createdAt: { $gte: midnight },
      });

      const maxLimit = process.env.EMBEDDING_DAILY_BUDGET !== undefined
        ? parseInt(process.env.EMBEDDING_DAILY_BUDGET, 10)
        : cfg.EMBEDDING_DAILY_BUDGET;

      const result = checkBudget({
        type: BUDGET_TYPES.EMBEDDING,
        currentCount: count,
        maxLimit,
      });

      if (!result.allowed) {
        const requestId = req.id || req.headers['x-request-id'] || 'unknown';
        return res.status(429).json({
          code: 'DAILY_BUDGET_REACHED',
          error: {
            code: 'DAILY_BUDGET_REACHED',
            message: result.error.message,
            requestId,
          },
          message: result.error.message,
        });
      }

      next();
    } catch (err) {
      next(err);
    }
  }

  return {
    guardUserVerifications,
    guardUserDailyReports,
    guardUserDailyGithubAnalyses,
    guardLlmGenerationBudget,
    guardEmbeddingBudget,
  };
}

const defaultGuards = createBudgetGuardMiddleware();

module.exports = {
  createBudgetGuardMiddleware,
  INTERVIEW_REPORT_PURPOSE,
  guardUserVerifications: defaultGuards.guardUserVerifications,
  guardUserDailyReports: defaultGuards.guardUserDailyReports,
  guardUserDailyGithubAnalyses: defaultGuards.guardUserDailyGithubAnalyses,
  guardLlmGenerationBudget: defaultGuards.guardLlmGenerationBudget,
  guardEmbeddingBudget: defaultGuards.guardEmbeddingBudget,
};
