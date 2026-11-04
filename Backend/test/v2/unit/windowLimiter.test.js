import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createWindowLimiter } = require('../../../src/v2/utils/windowLimiter');

/** A fake clock: sleep() advances time instead of waiting. */
function fakeClock() {
  let t = 1_000_000;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
    sleeps,
  };
}

describe('utils/windowLimiter', () => {
  it('lets units through immediately while they fit in the window', async () => {
    const clock = fakeClock();
    const acquire = createWindowLimiter(90, 60000, clock);
    await acquire(50);
    await acquire(40);
    expect(clock.sleeps).toEqual([]);
  });

  it('waits until the window has room when the next batch would exceed the limit', async () => {
    const clock = fakeClock();
    const acquire = createWindowLimiter(90, 60000, clock);
    await acquire(80);
    const before = clock.now();
    await acquire(20); // 80 + 20 > 90: must wait for the first batch to leave the window
    expect(clock.now() - before).toBeGreaterThanOrEqual(60000);
    expect(clock.sleeps.length).toBeGreaterThan(0);
  });

  it('counts units, not calls: one batch of 100 texts uses the whole minute (the real free-tier behaviour)', async () => {
    const clock = fakeClock();
    const acquire = createWindowLimiter(100, 60000, clock);
    await acquire(100);
    const before = clock.now();
    await acquire(1);
    expect(clock.now() - before).toBeGreaterThanOrEqual(60000);
  });

  it('never exceeds the limit within any 60 second window across many acquisitions', async () => {
    const clock = fakeClock();
    const acquire = createWindowLimiter(90, 60000, clock);
    const log = [];
    for (let i = 0; i < 10; i++) {
      await acquire(40);
      log.push({ t: clock.now(), n: 40 });
    }
    for (const entry of log) {
      const inWindow = log.filter((e) => e.t > entry.t - 60000 && e.t <= entry.t).reduce((s, e) => s + e.n, 0);
      expect(inWindow).toBeLessThanOrEqual(90);
    }
  });

  it('serves concurrent callers in order without exceeding the limit', async () => {
    const clock = fakeClock();
    const acquire = createWindowLimiter(60, 60000, clock);
    const order = [];
    await Promise.all([30, 30, 30, 30].map((n, i) => acquire(n).then(() => order.push(i))));
    expect(order).toEqual([0, 1, 2, 3]);
    expect(clock.sleeps.length).toBeGreaterThan(0); // the third and fourth had to wait
  });

  it('clamps a request larger than the limit so it cannot wait forever', async () => {
    const clock = fakeClock();
    const acquire = createWindowLimiter(50, 60000, clock);
    await expect(acquire(500)).resolves.toBeUndefined();
  });

  it('keeps working after units have aged out of the window', async () => {
    const clock = fakeClock();
    const acquire = createWindowLimiter(50, 60000, clock);
    await acquire(50);
    clock.advance(61000);
    const before = clock.sleeps.length;
    await acquire(50);
    expect(clock.sleeps.length).toBe(before); // no waiting needed
  });
});
