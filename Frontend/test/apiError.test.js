import { describe, it, expect } from 'vitest';
import { getApiErrorMessage } from '../src/services/apiError';

describe('getApiErrorMessage', () => {
  it('prefers the structured backend message', () => {
    const err = { response: { status: 422, data: { message: 'old', error: { code: 'X', message: 'Structured message' } } } };
    expect(getApiErrorMessage(err)).toBe('Structured message');
  });

  it('falls back to the legacy top-level message', () => {
    expect(getApiErrorMessage({ response: { status: 400, data: { message: 'Legacy message' } } })).toBe('Legacy message');
  });

  it('explains network failures when there is no response', () => {
    expect(getApiErrorMessage(new Error('Network Error'))).toMatch(/cannot reach the server/i);
  });

  it('maps bare status codes to friendly text', () => {
    expect(getApiErrorMessage({ response: { status: 401, data: {} } })).toMatch(/session has expired/i);
    expect(getApiErrorMessage({ response: { status: 429, data: {} } })).toMatch(/too many requests/i);
    expect(getApiErrorMessage({ response: { status: 500, data: '<html>' } }, 'Custom fallback')).toBe('Custom fallback');
  });

  it('never returns raw HTML or objects from the server', () => {
    const msg = getApiErrorMessage({ response: { status: 502, data: '<html>Bad gateway</html>' } });
    expect(msg).not.toContain('<html>');
  });
});
