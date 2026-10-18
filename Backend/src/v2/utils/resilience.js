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
 * Inspects an error for 429 quota exhaustion signals (per-minute vs per-day)
 * and extracts any upstream retry delay from error details.
 */
function extractQuotaInfo(err) {
  if (!err) return { is429: false, isPerDay: false, retryDelayMs: null, retryText: null };

  const status =
    err.status ||
    err.statusCode ||
    (err.response && err.response.status) ||
    null;

  const msg = err.message || '';
  const is429 = status === 429 || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');

  if (!is429) {
    return { is429: false, isPerDay: false, retryDelayMs: null, retryText: null };
  }

  let isPerDay = false;
  let retryDelayMs = null;
  let retryText = null;

  // Inspect details array if present in standard Google RPC format
  const details = err.errorDetails || err.details || err.response?.data?.error?.details || [];
  if (Array.isArray(details)) {
    for (const item of details) {
      if (item.violations && Array.isArray(item.violations)) {
        for (const v of item.violations) {
          if (v.quotaId && v.quotaId.includes('PerDay')) {
            isPerDay = true;
            retryText = v.description || msg;
          }
        }
      }
      if (item.quotaId && item.quotaId.includes('PerDay')) {
        isPerDay = true;
        retryText = item.description || msg;
      }
      if (item.retryDelay) {
        retryText = retryText || `Retry after ${JSON.stringify(item.retryDelay)}`;
        if (typeof item.retryDelay === 'string') {
          const sec = parseFloat(item.retryDelay.replace('s', ''));
          if (!isNaN(sec)) retryDelayMs = Math.round(sec * 1000);
        } else if (typeof item.retryDelay === 'number') {
          retryDelayMs = Math.round(item.retryDelay * 1000);
        } else if (item.retryDelay.seconds) {
          retryDelayMs = Number(item.retryDelay.seconds) * 1000;
        }
      }
    }
  }

  // Fallback string matching on message or direct quotaId property
  if (!isPerDay && (msg.includes('PerDay') || (err.quotaId && err.quotaId.includes('PerDay')))) {
    isPerDay = true;
    retryText = msg;
  }

  if (!retryDelayMs) {
    const header = err.response?.headers?.['retry-after'] || err.headers?.['retry-after'];
    if (header) {
      const sec = parseFloat(header);
      if (!isNaN(sec)) retryDelayMs = Math.round(sec * 1000);
    }
  }

  return { is429, isPerDay, retryDelayMs, retryText };
}

/**
 * Retries an async operation with exponential backoff and jitter for transient errors only.
 * Immediately aborts on per-day quota exhaustion without retrying.
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
  const { QuotaExhaustedError } = require('../errors/LlmErrors');
  const totalBudget = retries + 1;

  for (let attempt = 1; attempt <= totalBudget; attempt++) {
    try {
      if (logger && typeof logger.debug === 'function') {
        logger.debug({ purpose, attempt, totalBudget }, `Starting attempt ${attempt} of ${totalBudget}`);
      }
      return await fn({ attempt, totalBudget });
    } catch (err) {
      const quota = extractQuotaInfo(err);
      if (quota.isPerDay) {
        const fatalError = new QuotaExhaustedError(
          `Daily LLM quota exhausted: ${quota.retryText || err.message}`,
          quota.retryText || err.message
        );
        if (logger && typeof logger.warn === 'function') {
          logger.warn(
            {
              purpose,
              attempt,
              totalBudget,
              error: err.message,
              willRetry: false,
            },
            'Per-day quota limit hit; aborting immediately without retry.'
          );
        }
        throw fatalError;
      }

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

      // Calculate delay: use explicit retryDelay from upstream 429 if present, else exponential backoff with jitter
      const baseDelay = minTimeout * Math.pow(factor, attempt - 1);
      const standardDelay = randomize ? Math.round(baseDelay * (0.5 + Math.random() * 0.5)) : baseDelay;
      const delay = quota.retryDelayMs !== null ? quota.retryDelayMs : standardDelay;

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
  extractQuotaInfo,
  withTimeout,
  withRetry,
};
