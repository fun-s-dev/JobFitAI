import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  withRetry,
  withTimeout,
  isTransientError,
  TimeoutError,
} = require('../../../src/v2/utils/resilience');

describe('v2 Resilience Utilities (withRetry & withTimeout)', () => {
  describe('isTransientError predicate', () => {
    it('identifies 429, 500, 502, 503, 504 and network errors as transient', () => {
      expect(isTransientError({ status: 429 })).toBe(true);
      expect(isTransientError({ status: 500 })).toBe(true);
      expect(isTransientError({ status: 502 })).toBe(true);
      expect(isTransientError({ status: 503 })).toBe(true);
      expect(isTransientError({ status: 504 })).toBe(true);
      expect(isTransientError({ code: 'ECONNRESET' })).toBe(true);
      expect(isTransientError({ code: 'ETIMEDOUT' })).toBe(true);
      expect(isTransientError({ name: 'TimeoutError' })).toBe(true);
      expect(isTransientError({ name: 'AbortError' })).toBe(true);
    });

    it('rejects 400, 401, 403, 404 as non-transient', () => {
      expect(isTransientError({ status: 400 })).toBe(false);
      expect(isTransientError({ status: 401 })).toBe(false);
      expect(isTransientError({ status: 403 })).toBe(false);
      expect(isTransientError({ status: 404 })).toBe(false);
      expect(isTransientError(new Error('Syntax validation failed'))).toBe(false);
    });
  });

  describe('withRetry', () => {
    it('resolves immediately when function succeeds on attempt 1', async () => {
      let calls = 0;
      const result = await withRetry(async () => {
        calls++;
        return 'success';
      }, { retries: 2, minTimeout: 10 });

      expect(result).toBe('success');
      expect(calls).toBe(1);
    });

    it('retries transient 503 error and succeeds on attempt 2', async () => {
      let calls = 0;
      const result = await withRetry(async () => {
        calls++;
        if (calls === 1) {
          const err = new Error('Service Unavailable');
          err.status = 503;
          throw err;
        }
        return 'recovered';
      }, { retries: 2, minTimeout: 10 });

      expect(result).toBe('recovered');
      expect(calls).toBe(2);
    });

    it('never retries HTTP 400 Bad Request and fails immediately', async () => {
      let calls = 0;
      const badRequestError = new Error('Invalid schema parameter');
      badRequestError.status = 400;

      await expect(
        withRetry(async () => {
          calls++;
          throw badRequestError;
        }, { retries: 2, minTimeout: 10 })
      ).rejects.toThrow('Invalid schema parameter');

      expect(calls).toBe(1); // Exactly 1 attempt, zero retries
    });

    it('exhausts all retries when transient error persists', async () => {
      let calls = 0;
      const err = new Error('Too Many Requests');
      err.status = 429;

      await expect(
        withRetry(async () => {
          calls++;
          throw err;
        }, { retries: 2, minTimeout: 10 })
      ).rejects.toThrow('Too Many Requests');

      // 1 initial attempt + 2 retries = 3 attempts
      expect(calls).toBe(3);
    });
  });

  describe('withTimeout', () => {
    it('returns result when operation completes within timeout', async () => {
      const result = await withTimeout(async () => {
        return 'quick result';
      }, 500);

      expect(result).toBe('quick result');
    });

    it('aborts and throws TimeoutError when operation exceeds timeout', async () => {
      let aborted = false;

      await expect(
        withTimeout(async ({ signal }) => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
          await new Promise((r) => setTimeout(r, 200));
          return 'late';
        }, 30)
      ).rejects.toThrow(TimeoutError);

      expect(aborted).toBe(true);
    });
  });
});
