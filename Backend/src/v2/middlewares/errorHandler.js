/**
 * v2 Router-scoped Error Handler & Not Found Handler
 * Enforces error contract: { error: { code, message, requestId } }
 * Never leaks stack traces or raw SDK/internal errors.
 */

function errorHandler(err, req, res, _next) {
  const requestId = req.id || req.headers['x-request-id'] || 'unknown';
  const statusCode = err.statusCode || err.status || 500;
  const code = err.code || err.name || 'INTERNAL_ERROR';
  const message = (statusCode >= 500 && process.env.NODE_ENV === 'production')
    ? 'An internal server error occurred'
    : (err.message || 'An unexpected error occurred');

  if (req.log && typeof req.log.error === 'function') {
    req.log.error({ err, requestId, statusCode, code }, 'v2 request error');
  }

  res.status(statusCode).json({
    error: {
      code,
      message,
      requestId,
    },
  });
}

function notFoundHandler(req, res) {
  const requestId = req.id || req.headers['x-request-id'] || 'unknown';
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Resource not found: ${req.method} ${req.originalUrl || req.url}`,
      requestId,
    },
  });
}

module.exports = {
  errorHandler,
  notFoundHandler,
};
