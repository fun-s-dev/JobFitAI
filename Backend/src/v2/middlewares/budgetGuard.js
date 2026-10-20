const { getCfg } = require('../config/env');
const { getMidnightPacific, checkBudget, BUDGET_TYPES } = require('../core/budgetGuards');
const VerificationRun = require('../models/verificationRun.model');
const LlmCall = require('../models/llmCall.model');

/**
 * Creates budget guard middlewares with dependency injection for testing.
 */
function createBudgetGuardMiddleware({
  verificationRunModel = VerificationRun,
  llmCallModel = LlmCall,
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
    guardLlmGenerationBudget,
    guardEmbeddingBudget,
  };
}

const defaultGuards = createBudgetGuardMiddleware();

module.exports = {
  createBudgetGuardMiddleware,
  guardUserVerifications: defaultGuards.guardUserVerifications,
  guardLlmGenerationBudget: defaultGuards.guardLlmGenerationBudget,
  guardEmbeddingBudget: defaultGuards.guardEmbeddingBudget,
};
