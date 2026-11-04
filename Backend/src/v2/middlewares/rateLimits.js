const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

/**
 * Factory for rate limiters.
 * Keys by authenticated user ID (req.user._id / req.user.id), falling back to client IP via ipKeyGenerator.
 * Formats errors according to the v2 error contract. The body also carries a top-level `message`
 * (the V1 frontend reads `response.data.message`).
 *
 * @param {object} [options]
 * @param {boolean} [options.skipSuccessfulRequests=false] Count only failed (status >= 400) requests,
 *   used for login so legitimate users are never locked out by their own successful logins.
 */
function createRateLimiter({
  windowMs = 15 * 60 * 1000,
  max = 10,
  message = 'Too many requests, please try again later',
  skipSuccessfulRequests = false,
} = {}) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests,
    keyGenerator: (req) => {
      if (req.user && (req.user._id || req.user.id)) {
        return String(req.user._id || req.user.id);
      }
      return ipKeyGenerator(req.ip || req.socket?.remoteAddress || '127.0.0.1');
    },
    handler: (req, res) => {
      const requestId = req.id || req.headers['x-request-id'] || 'unknown';
      res.status(429).json({
        message,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message,
          requestId,
        },
      });
    },
  });
}

module.exports = {
  createRateLimiter,
};
