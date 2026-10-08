import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { Writable } from 'node:stream';
import request from 'supertest';

const require = createRequire(import.meta.url);
const express = require('express');
const { createLogger, createHttpLogger } = require('../../../src/v2/utils/logger');

describe('v2 Logging & Redaction (pino / pino-http)', () => {
  it('redacts sensitive headers (cookie, authorization, set-cookie) in log output', async () => {
    let loggedData = '';
    const captureStream = new Writable({
      write(chunk, encoding, callback) {
        loggedData += chunk.toString();
        callback();
      },
    });

    const logger = createLogger({ stream: captureStream, level: 'info' });
    const httpLogger = createHttpLogger({ logger });

    const app = express();
    app.use(httpLogger);

    app.get('/test-redaction', (req, res) => {
      res.setHeader('Set-Cookie', 'secret_cookie_val=xyz; HttpOnly');
      req.log.info({ testContext: 'processing' }, 'handled route');
      res.status(200).json({ ok: true });
    });

    const secretCookie = 'token=super_secret_jwt_token_12345; session=abc';
    const secretAuth = 'Bearer secret_bearer_token';

    const response = await request(app)
      .get('/test-redaction')
      .set('Cookie', secretCookie)
      .set('Authorization', secretAuth);

    expect(response.status).toBe(200);

    // X-Request-Id header must be present on response
    const reqId = response.headers['x-request-id'];
    expect(reqId).toBeDefined();
    expect(typeof reqId).toBe('string');
    expect(reqId.length).toBeGreaterThan(0);

    // Sensitive values must NEVER appear in the captured log stream
    expect(loggedData).not.toContain('super_secret_jwt_token_12345');
    expect(loggedData).not.toContain('secret_bearer_token');
    expect(loggedData).not.toContain('secret_cookie_val');

    // And redaction placeholder should appear
    expect(loggedData).toContain('[REDACTED]');
  });
});
