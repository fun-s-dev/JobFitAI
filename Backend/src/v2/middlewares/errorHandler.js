/**
 * v2 Router-scoped Error Handler & Not Found Handler
 * Enforces error contract: { error: { code, message, requestId } }
 * Never leaks stack traces or raw SDK/internal errors.
 */

function errorHandler(err, req, res, _next) {
  const requestId = req.id || req.headers['x-request-id'] || 'unknown';
  let statusCode = err.statusCode || err.status || 500;
  let code = err.code || err.name || 'INTERNAL_ERROR';

  if (err.name === 'QuotaExhaustedError' || code === 'LLM_QUOTA_EXHAUSTED' || statusCode === 429) {
    statusCode = 429;
    code = 'LLM_QUOTA_EXHAUSTED';
  } else if (statusCode === 503 && (code === 'INTERNAL_ERROR' || code === 'Error')) {
    code = 'SERVICE_UNAVAILABLE';
  } else if (statusCode === 502 && (code === 'INTERNAL_ERROR' || code === 'Error')) {
    code = 'BAD_GATEWAY';
  }

  let message;
  if (code === 'LLM_QUOTA_EXHAUSTED') {
    message = 'Daily AI quota has been exhausted. Please try again tomorrow or contact support.';
  } else if (statusCode === 503) {
    message = 'Upstream AI service is temporarily unavailable. Please try again later.';
  } else if (statusCode === 502) {
    message = 'Bad gateway: upstream AI service failed to complete the request.';
  } else if (statusCode >= 500 && process.env.NODE_ENV === 'production') {
    message = 'An internal server error occurred';
  } else {
    message = err.message || 'An unexpected error occurred';
  }

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
