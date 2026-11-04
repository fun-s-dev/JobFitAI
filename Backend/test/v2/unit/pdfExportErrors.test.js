import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  resolveExecutablePath,
  PdfRendererUnavailableError,
} = require('../../../src/v2/adapters/pdfRenderer');
const { createDraftController } = require('../../../src/v2/controllers/draft.controller');

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.status = vi.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body) => {
    res.body = body;
    return res;
  });
  res.setHeader = vi.fn((k, v) => {
    res.headers[k] = v;
  });
  res.send = vi.fn(() => res);
  return res;
}

describe('adapters/pdfRenderer: executable resolution', () => {
  it('returns undefined when PUPPETEER_EXECUTABLE_PATH is not set (use Puppeteer default browser)', () => {
    expect(resolveExecutablePath({})).toBeUndefined();
  });

  it('throws PdfRendererUnavailableError when the configured Chromium binary is missing', () => {
    expect(() =>
      resolveExecutablePath({ PUPPETEER_EXECUTABLE_PATH: '/definitely/not/here/chromium' })
    ).toThrow(PdfRendererUnavailableError);
  });

  it('returns the configured path when the file exists', () => {
    expect(resolveExecutablePath({ PUPPETEER_EXECUTABLE_PATH: process.execPath })).toBe(process.execPath);
  });
});

describe('draft.controller renderDraftPdf: disabled renderer', () => {
  it('returns 501 NOT_IMPLEMENTED without touching the database when PDF rendering is disabled', async () => {
    const draftModel = { findOne: vi.fn() };
    const controller = createDraftController({
      draftService: { generateDraft: vi.fn() },
      draftModel,
      configGetter: () => ({ PDF_RENDERING_ENABLED: false }),
    });

    const res = fakeRes();
    const next = vi.fn();
    await controller.renderDraftPdf(
      { headers: {}, user: { id: 'u1' }, report: { _id: 'r1' }, body: {}, query: {} },
      res,
      next
    );

    expect(res.statusCode).toBe(501);
    expect(res.body.error.code).toBe('NOT_IMPLEMENTED');
    expect(res.body.error.message).toMatch(/Print \/ Save as PDF/);
    expect(draftModel.findOne).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});
