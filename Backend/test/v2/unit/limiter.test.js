import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLimiter } = require('../../../src/v2/utils/limiter');

describe('utils/limiter (concurrency control)', () => {
  it('limits active concurrent executions to the specified limit', async () => {
    const limit = createLimiter(2);
    let active = 0;
    let maxActiveSeen = 0;

    const task = (ms) =>
      limit(async () => {
        active++;
        if (active > maxActiveSeen) maxActiveSeen = active;
        await new Promise((r) => setTimeout(r, ms));
        active--;
        return ms;
      });

    const results = await Promise.all([
      task(30),
      task(30),
      task(30),
      task(30),
      task(30),
    ]);

    expect(results).toEqual([30, 30, 30, 30, 30]);
    expect(maxActiveSeen).toBeLessThanOrEqual(2);
  });

  it('propagates task errors without breaking the queue for subsequent tasks', async () => {
    const limit = createLimiter(1);
    const failTask = limit(async () => {
      throw new Error('boom');
    });
    const successTask = limit(async () => 'ok');

    await expect(failTask).rejects.toThrow('boom');
    await expect(successTask).resolves.toBe('ok');
  });
});
