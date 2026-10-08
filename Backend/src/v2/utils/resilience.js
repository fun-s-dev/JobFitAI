class TimeoutError extends Error {
  constructor(message = 'Operation timed out') {
    super(message);
    this.name = 'TimeoutError';
    this.isTimeout = true;
  }
}

/**
 * Predicate to decide if an error is transient and safe to retry.
 * Retries: 429, 500, 502, 503, 504, network reset/timeouts, AbortError.
 * Never retries: 400, 401, 403, 404, or non-transient client errors.
 */
function isTransientError(err) {
  if (!err) return false;

  const status =
    err.status ||
    err.statusCode ||
    (err.response && err.response.status) ||
    null;

  if (status) {
    if ([400, 401, 403, 404].includes(status)) {
      return false;
    }
    if ([429, 500, 502, 503, 504].includes(status)) {
      return true;
    }
  }

  // Network and timeout error signatures
  const code = err.code || '';
  if (['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED'].includes(code)) {
    return true;
  }

  if (err.name === 'TimeoutError' || err.name === 'AbortError') {
    return true;
  }

  const message = (err.message || '').toLowerCase();
  if (message.includes('timeout') || message.includes('econnreset') || message.includes('network')) {
    return true;
  }

  return false;
}

/**
 * Wraps an async function with a timeout enforced via AbortController.
 */
async function withTimeout(fn, ms = 30000) {
  const controller = new AbortController();
  let timerId;

  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(`Request timed out after ${ms}ms`));
    }, ms);
  });

  try {
    const result = await Promise.race([
      fn({ signal: controller.signal }),
      timeoutPromise,
    ]);
    return result;
  } finally {
    clearTimeout(timerId);
  }
}

/**
 * Retries an async operation with exponential backoff and jitter for transient errors only.
 */
async function withRetry(
  fn,
  {
    retries = 2,
    minTimeout = 500,
    factor = 2,
    randomize = true,
    shouldRetry = isTransientError,
    logger,
    purpose = 'operation',
  } = {}
) {
  const totalBudget = retries + 1;

  for (let attempt = 1; attempt <= totalBudget; attempt++) {
    try {
      if (logger && typeof logger.debug === 'function') {
        logger.debug({ purpose, attempt, totalBudget }, `Starting attempt ${attempt} of ${totalBudget}`);
      }
      return await fn({ attempt, totalBudget });
    } catch (err) {
      const canRetry = attempt < totalBudget && shouldRetry(err);

      if (!canRetry) {
        if (logger && typeof logger.warn === 'function') {
          logger.warn(
            {
              purpose,
              attempt,
              totalBudget,
              status: err.status || err.statusCode,
              error: err.message,
              willRetry: false,
            },
            `Attempt ${attempt} of ${totalBudget} failed permanently; not retrying.`
          );
        }
        throw err;
      }

      // Calculate exponential backoff with full jitter
      const baseDelay = minTimeout * Math.pow(factor, attempt - 1);
      const delay = randomize ? Math.round(baseDelay * (0.5 + Math.random() * 0.5)) : baseDelay;

      if (logger && typeof logger.warn === 'function') {
        logger.warn(
          {
            purpose,
            attempt,
            totalBudget,
            delayMs: delay,
            status: err.status || err.statusCode,
            error: err.message,
            willRetry: true,
          },
          `Attempt ${attempt} of ${totalBudget} failed with transient error; retrying in ${delay}ms.`
        );
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

module.exports = {
  TimeoutError,
  isTransientError,
  withTimeout,
  withRetry,
};
