const pino = require('pino');
const pinoHttp = require('pino-http');
const crypto = require('crypto');

const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  'headers.cookie',
  'headers.authorization',
];

function createLogger(options = {}) {
  const stream = options.stream;
  const level = options.level || process.env.LOG_LEVEL || 'info';

  const pinoOptions = {
    level: process.env.NODE_ENV === 'test' ? (options.level || 'silent') : level,
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...options.pinoOptions,
  };

  return stream ? pino(pinoOptions, stream) : pino(pinoOptions);
}

const defaultLogger = createLogger();

// The GitHub OAuth callback carries a one-time authorization `code` and the `state` in its query string.
// They must never reach the logs.
const SENSITIVE_QUERY_PATHS = /\/github\/connect\/callback(?=[?#]|$)/;

function sanitizeLoggedUrl(url) {
  if (typeof url !== 'string' || !SENSITIVE_QUERY_PATHS.test(url)) return url;
  const queryStart = url.indexOf('?');
  return queryStart === -1 ? url : `${url.slice(0, queryStart)}?[REDACTED]`;
}

function createHttpLogger(options = {}) {
  const logger = options.logger || defaultLogger;

  return pinoHttp({
    logger,
    serializers: {
      req(req) {
        const serialized = pinoHttp.stdSerializers.req(req);
        const safeUrl = sanitizeLoggedUrl(serialized.url);
        if (safeUrl !== serialized.url) {
          serialized.url = safeUrl;
          delete serialized.query;
        }
        return serialized;
      },
    },
    genReqId: (req, res) => {
      const existing = req.headers['x-request-id'];
      const id = (typeof existing === 'string' && existing.trim()) ? existing : crypto.randomUUID();
      if (res && typeof res.setHeader === 'function') {
        res.setHeader('x-request-id', id);
      }
      return id;
    },
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
    ...options.pinoHttpOptions,
  });
}

module.exports = {
  createLogger,
  createHttpLogger,
  sanitizeLoggedUrl,
  logger: defaultLogger,
};
