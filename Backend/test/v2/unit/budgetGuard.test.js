import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  getMidnightPacific,
  checkBudget,
  BUDGET_TYPES,
} = require('../../../src/v2/core/budgetGuards');

describe('Core Budget Guards & Timezone Logic (Pure)', () => {
  describe('getMidnightPacific', () => {
    it('calculates midnight Pacific correctly during Daylight Saving Time (PDT, UTC-7)', () => {
      // 2026-07-15 15:30:00 UTC -> 08:30:00 PDT
      const testDate = new Date('2026-07-15T15:30:00.000Z');
      const midnight = getMidnightPacific(testDate);

      // In PDT (UTC-7), midnight 2026-07-15 00:00:00 PDT is 2026-07-15 07:00:00 UTC
      expect(midnight.toISOString()).toBe('2026-07-15T07:00:00.000Z');
    });

    it('calculates midnight Pacific correctly during Standard Time (PST, UTC-8)', () => {
      // 2026-12-15 15:30:00 UTC -> 07:30:00 PST
      const testDate = new Date('2026-12-15T15:30:00.000Z');
      const midnight = getMidnightPacific(testDate);

      // In PST (UTC-8), midnight 2026-12-15 00:00:00 PST is 2026-12-15 08:00:00 UTC
      expect(midnight.toISOString()).toBe('2026-12-15T08:00:00.000Z');
    });

    it('handles exact Pacific day boundary rollover', () => {
      // 2026-10-20 06:59:59 UTC -> 2026-10-19 23:59:59 PDT
      const beforeMidnight = new Date('2026-10-20T06:59:59.000Z');
      const midnightBefore = getMidnightPacific(beforeMidnight);
      expect(midnightBefore.toISOString()).toBe('2026-10-19T07:00:00.000Z');

      // 2026-10-20 07:00:01 UTC -> 2026-10-20 00:00:01 PDT
      const afterMidnight = new Date('2026-10-20T07:00:01.000Z');
      const midnightAfter = getMidnightPacific(afterMidnight);
      expect(midnightAfter.toISOString()).toBe('2026-10-20T07:00:00.000Z');
    });
  });

  describe('checkBudget', () => {
    it('allows execution when count is strictly below the limit', () => {
      const result = checkBudget({
        type: BUDGET_TYPES.USER_VERIFICATIONS,
        currentCount: 2,
        maxLimit: 3,
      });

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(1);
      expect(result.error).toBeNull();
    });

    it('rejects when currentCount reaches the limit with DAILY_BUDGET_REACHED', () => {
      const result = checkBudget({
        type: BUDGET_TYPES.USER_VERIFICATIONS,
        currentCount: 3,
        maxLimit: 3,
      });

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.error).toBeDefined();
      expect(result.error.code).toBe('DAILY_BUDGET_REACHED');
      expect(result.error.message).toMatch(/limit reached/i);
    });

    it('rejects when currentCount exceeds the limit', () => {
      const result = checkBudget({
        type: BUDGET_TYPES.LLM_GENERATION,
        currentCount: 405,
        maxLimit: 400,
      });

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.error.code).toBe('DAILY_BUDGET_REACHED');
      expect(result.error.message).toContain('400');
    });

    it('handles embedding daily budget type cleanly', () => {
      const result = checkBudget({
        type: BUDGET_TYPES.EMBEDDING,
        currentCount: 800,
        maxLimit: 800,
      });

      expect(result.allowed).toBe(false);
      expect(result.error.code).toBe('DAILY_BUDGET_REACHED');
      expect(result.error.message).toMatch(/embedding/i);
    });
  });

  describe('Fake clock day boundary simulation', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('resets budget when system clock moves past midnight Pacific', () => {
      // Set time to 2026-10-20 23:59:00 PDT -> 2026-10-21 06:59:00 UTC
      vi.setSystemTime(new Date('2026-10-21T06:59:00.000Z'));
      const midnightDay1 = getMidnightPacific();
      expect(midnightDay1.toISOString()).toBe('2026-10-20T07:00:00.000Z');

      // Advance clock by 2 minutes into the new Pacific day (00:01:00 PDT -> 07:01:00 UTC)
      vi.advanceTimersByTime(2 * 60 * 1000);
      const midnightDay2 = getMidnightPacific();
      expect(midnightDay2.toISOString()).toBe('2026-10-21T07:00:00.000Z');
      expect(midnightDay2.getTime()).toBeGreaterThan(midnightDay1.getTime());
    });
  });
});
