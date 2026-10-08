/**
 * Zod validation middleware for request params, query, and body.
 * Responds with 400 Bad Request if validation fails.
 */
function validate({ params, query, body } = {}) {
  return (req, res, next) => {
    const requestId = req.id || req.headers['x-request-id'] || 'unknown';

    if (params) {
      const result = params.safeParse(req.params);
      if (!result.success) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request path parameters',
            requestId,
            details: result.error.issues,
          },
        });
      }
      req.params = result.data;
    }

    if (query) {
      const result = query.safeParse(req.query);
      if (!result.success) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request query parameters',
            requestId,
            details: result.error.issues,
          },
        });
      }
      req.query = result.data;
    }

    if (body) {
      const result = body.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request body',
            requestId,
            details: result.error.issues,
          },
        });
      }
      req.body = result.data;
    }

    next();
  };
}

module.exports = {
  validate,
};
