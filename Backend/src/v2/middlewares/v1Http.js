/**
 * HTTP helpers for the V1 API (/api/auth, /api/interview).
 *
 * V1 error contract (a superset of the old `{ message }` shape, so the existing frontend keeps working,
 * plus the V2-style structured error):
 *   { message, error: { code, message, requestId, details? } }
 */

function getRequestId(req) {
  return req.id || (req.headers && req.headers['x-request-id']) || 'unknown';
}

function sendV1Error(req, res, status, code, message, details) {
  const error = { code, message, requestId: getRequestId(req) };
  if (details !== undefined) error.details = details;
  return res.status(status).json({ message, error });
}

/**
 * Zod validation for V1 routes. On failure responds 400 with the first issue's message as the
 * top-level `message` (shown to the user) and all issues in `error.details`.
 * Replaces req.params / req.body with the parsed (trimmed, normalized, unknown-keys-stripped) data.
 */
function validateV1({ params, body } = {}) {
  return (req, res, next) => {
    if (params) {
      const parsed = params.safeParse(req.params);
      if (!parsed.success) {
        return sendV1Error(req, res, 404, 'NOT_FOUND', 'Interview report not found.');
      }
      req.params = parsed.data;
    }

    if (body) {
      const parsed = body.safeParse(req.body ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        return sendV1Error(
          req,
          res,
          400,
          'VALIDATION_ERROR',
          (first && first.message) || 'Invalid request.',
          parsed.error.issues.map((i) => ({ path: i.path, message: i.message }))
        );
      }
      req.body = parsed.data;
    }

    next();
  };
}

/**
 * Allows only one in-flight request per authenticated user for a given route group.
 * Prevents a double click or a script from starting parallel AI calls.
 * In-memory: correct for a single process (the deployment target); with several instances
 * it only protects each instance.
 */
function createInFlightLimiter({ message = 'A request is already being processed. Please wait for it to finish.' } = {}) {
  const active = new Set();

  return function inFlightLimit(req, res, next) {
    const userId = req.user ? String(req.user._id || req.user.id) : null;
    if (!userId) return next();

    if (active.has(userId)) {
      return sendV1Error(req, res, 409, 'REQUEST_IN_PROGRESS', message);
    }

    active.add(userId);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active.delete(userId);
    };
    // 'close' fires when the response finished OR the client disconnected
    res.on('close', release);
    res.on('finish', release);
    next();
  };
}

/** JSON 404 for unknown /api paths that no router claimed. */
function apiNotFoundHandler(req, res) {
  return sendV1Error(req, res, 404, 'NOT_FOUND', `Resource not found: ${req.method} ${req.originalUrl || req.url}`);
}

/**
 * App-level error handler (V2 routes keep their own router-scoped handler).
 * Never leaks stack traces or raw error messages for unexpected errors.
 */
function globalErrorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err && err.type === 'entity.parse.failed') {
    return sendV1Error(req, res, 400, 'INVALID_JSON', 'The request body is not valid JSON.');
  }
  if (err && err.type === 'entity.too.large') {
    return sendV1Error(req, res, 413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.');
  }
  if (err && err.name === 'CastError') {
    return sendV1Error(req, res, 404, 'NOT_FOUND', 'Resource not found.');
  }

  const status = Number(err && (err.statusCode || err.status));
  if (req.log && typeof req.log.error === 'function') {
    req.log.error({ err, requestId: getRequestId(req) }, 'Unhandled request error');
  }

  if (status >= 400 && status < 500) {
    return sendV1Error(req, res, status, 'REQUEST_ERROR', 'The request could not be processed.');
  }
  return sendV1Error(req, res, 500, 'INTERNAL_ERROR', 'Something went wrong on our side. Please try again.');
}

module.exports = {
  getRequestId,
  sendV1Error,
  validateV1,
  createInFlightLimiter,
  apiNotFoundHandler,
  globalErrorHandler,
};
