import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/services/apiClient', () => ({
  API_BASE: '',
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}));

import { api } from '../src/services/apiClient';
import { getPrintDraftUrl, downloadGroundedPdf } from '../src/features/verification/services/verification.api';

describe('verification.api export helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getPrintDraftUrl builds a same-origin print URL without throwing (regression: undefined API_BASE)', () => {
    expect(getPrintDraftUrl('abc123')).toBe('/api/v2/drafts/abc123/print');
    expect(getPrintDraftUrl('abc123', 'run9')).toBe('/api/v2/drafts/abc123/print?runId=run9');
  });

  it('downloadGroundedPdf returns the blob on success and omits runId when absent', async () => {
    const blob = new Blob(['%PDF-1.4'], { type: 'application/pdf' });
    api.post.mockResolvedValueOnce({ data: blob });

    await expect(downloadGroundedPdf('abc123')).resolves.toBe(blob);
    expect(api.post).toHaveBeenCalledWith('/api/v2/drafts/abc123/pdf', {}, { responseType: 'blob' });
  });

  it('downloadGroundedPdf turns a JSON error delivered as a Blob back into an object', async () => {
    const body = { error: { code: 'PDF_RENDERER_UNAVAILABLE', message: 'Use Print / Save as PDF instead.' } };
    const err = Object.assign(new Error('Request failed'), {
      response: { status: 503, data: new Blob([JSON.stringify(body)], { type: 'application/json' }) },
    });
    api.post.mockRejectedValueOnce(err);

    const thrown = await downloadGroundedPdf('abc123', 'run9').catch((e) => e);
    expect(thrown.response.status).toBe(503);
    expect(thrown.response.data.error.code).toBe('PDF_RENDERER_UNAVAILABLE');
    expect(api.post).toHaveBeenCalledWith('/api/v2/drafts/abc123/pdf', { runId: 'run9' }, { responseType: 'blob' });
  });
});
