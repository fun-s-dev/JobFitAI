import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getEffectiveStatus } = require('../../../src/v2/core/effectiveStatus');

describe('getEffectiveStatus (pure)', () => {
  it('returns automated status when userOverride is null or undefined', () => {
    expect(getEffectiveStatus({ status: 'needs_review', userOverride: null })).toBe('needs_review');
    expect(getEffectiveStatus({ status: 'verified' })).toBe('verified');
    expect(getEffectiveStatus({ status: 'rejected', userOverride: undefined })).toBe('rejected');
  });

  it('returns userOverride.decision when present, overriding automated status', () => {
    expect(
      getEffectiveStatus({
        status: 'needs_review',
        userOverride: { decision: 'approved', at: new Date() },
      })
    ).toBe('approved');

    expect(
      getEffectiveStatus({
        status: 'verified',
        userOverride: { decision: 'rejected', at: new Date() },
      })
    ).toBe('rejected');
  });

  it('handles null/empty claim gracefully', () => {
    expect(getEffectiveStatus(null)).toBe('rejected');
    expect(getEffectiveStatus({})).toBe('rejected');
  });
});
