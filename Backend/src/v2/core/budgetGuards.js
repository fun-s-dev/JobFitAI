/**
 * Pure budget guard logic and Pacific timezone midnight calculations.
 * Strictly pure: No I/O, no database queries, no external network calls.
 */

const BUDGET_TYPES = {
  USER_VERIFICATIONS: 'USER_VERIFICATIONS',
  LLM_GENERATION: 'LLM_GENERATION',
  EMBEDDING: 'EMBEDDING',
};

/**
 * Calculates the exact UTC Date corresponding to midnight (00:00:00) in America/Los_Angeles
 * for the provided instant (defaults to new Date()).
 *
 * @param {Date} [now=new Date()]
 * @returns {Date}
 */
function getMidnightPacific(now = new Date()) {
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const tzParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'longOffset',
  }).formatToParts(now);
  const offset = tzParts.find((p) => p.type === 'timeZoneName').value.replace('GMT', '');
  return new Date(`${dateStr}T00:00:00${offset}`);
}

/**
 * Pure evaluation function for daily limits.
 *
 * @param {Object} params
 * @param {string} params.type - One of BUDGET_TYPES
 * @param {number} params.currentCount - Number of actions already recorded since midnight Pacific
 * @param {number} params.maxLimit - Maximum permitted count
 * @returns {{ allowed: boolean, remaining: number, error: { code: string, message: string } | null }}
 */
function checkBudget({ type, currentCount, maxLimit }) {
  const allowed = currentCount < maxLimit;
  const remaining = Math.max(0, maxLimit - currentCount);

  if (allowed) {
    return {
      allowed: true,
      remaining,
      error: null,
    };
  }

  let message = `Daily budget limit reached (${maxLimit} max). Please try again tomorrow.`;
  if (type === BUDGET_TYPES.USER_VERIFICATIONS) {
    message = `User daily verification limit reached (${maxLimit} per day). Reset at midnight Pacific.`;
  } else if (type === BUDGET_TYPES.LLM_GENERATION) {
    message = `Daily LLM generation budget reached (${maxLimit} calls per day for pinned model). Reset at midnight Pacific.`;
  } else if (type === BUDGET_TYPES.EMBEDDING) {
    message = `Daily embedding budget reached (${maxLimit} calls per day). Reset at midnight Pacific.`;
  }

  return {
    allowed: false,
    remaining: 0,
    error: {
      code: 'DAILY_BUDGET_REACHED',
      message,
    },
  };
}

module.exports = {
  BUDGET_TYPES,
  getMidnightPacific,
  checkBudget,
};
