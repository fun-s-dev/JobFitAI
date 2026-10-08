const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

/**
 * Factory for rate limiters.
 * Keys by authenticated user ID (req.user._id / req.user.id), falling back to client IP via ipKeyGenerator.
 * Formats errors according to the v2 error contract.
 */
function createRateLimiter({
  windowMs = 15 * 60 * 1000,
  max = 10,
  message = 'Too many requests, please try again later',
} = {}) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => {
      if (req.user && (req.user._id || req.user.id)) {
        return String(req.user._id || req.user.id);
      }
      return ipKeyGenerator(req.ip || req.socket?.remoteAddress || '127.0.0.1');
    },
    handler: (req, res) => {
      const requestId = req.id || req.headers['x-request-id'] || 'unknown';
      res.status(429).json({
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
