/**
 * Sliding-window limiter that counts UNITS, not calls.
 *
 * Why: Google's free embedding quota is "requests per minute" where every text in a batch counts as
 * one request, so a single call with 100 texts uses the whole minute. A limiter on the number of
 * calls does not protect against that. `acquire(n)` waits until n more units fit in the window.
 * Acquisitions are served in order. Units larger than the window are clamped to it so they cannot
 * wait forever.
 *
 * @param {number} maxPerWindow - units allowed per window
 * @param {number} [windowMs=60000]
 * @param {{ now?: () => number, sleep?: (ms: number) => Promise<void> }} [clock] injectable for tests
 * @returns {(units: number) => Promise<void>}
 */
function createWindowLimiter(
  maxPerWindow,
  windowMs = 60000,
  { now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}
) {
  const cap = Math.max(1, Math.floor(maxPerWindow) || 1);
  const events = []; // { t, n }
  let tail = Promise.resolve();

  async function waitForRoom(units) {
    for (;;) {
      const cutoff = now() - windowMs;
      while (events.length > 0 && events[0].t <= cutoff) events.shift();
      const used = events.reduce((sum, e) => sum + e.n, 0);
      if (used + units <= cap) {
        events.push({ t: now(), n: units });
        return;
      }
      const waitMs = events[0].t + windowMs - now() + 25;
      await sleep(Math.max(25, waitMs));
    }
  }

  return function acquire(units = 1) {
    const take = Math.min(Math.max(1, Math.floor(units) || 1), cap);
    const run = () => waitForRoom(take);
    const result = tail.then(run, run);
    tail = result.catch(() => {});
    return result;
  };
}

module.exports = { createWindowLimiter };
