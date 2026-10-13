/**
 * Pure lightweight concurrency limiter (CommonJS, 0 dependencies).
 * Caps the maximum number of concurrent async tasks running simultaneously.
 *
 * @param {number} concurrency - Maximum concurrent tasks (default 5)
 * @returns {function(function(): Promise<any>): Promise<any>}
 */
function createLimiter(concurrency = 5) {
  const cap = Math.max(1, concurrency || 1);
  let active = 0;
  const queue = [];

  function next() {
    if (active < cap && queue.length > 0) {
      active++;
      const { fn, resolve, reject } = queue.shift();
      Promise.resolve()
        .then(fn)
        .then(
          (val) => {
            active--;
            resolve(val);
            next();
          },
          (err) => {
            active--;
            reject(err);
            next();
          }
        );
    }
  }

  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

module.exports = {
  createLimiter,
};
