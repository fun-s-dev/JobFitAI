const fs = require('node:fs');
const puppeteer = require('puppeteer');
const { renderDraftToHtml } = require('../templates/resumePdfTemplate');
const { createLimiter } = require('../utils/limiter');
const { getCfg } = require('../config/env');

/**
 * Raised when Chromium cannot be found or launched (e.g. image built without Chromium).
 * Controllers translate it into a 503 that tells the user to use the print view.
 */
class PdfRendererUnavailableError extends Error {
  constructor(message = 'Server-side PDF renderer is unavailable') {
    super(message);
    this.name = 'PdfRendererUnavailableError';
    this.code = 'PDF_RENDERER_UNAVAILABLE';
    this.status = 503;
  }
}

/**
 * Resolves the Chromium binary. When PUPPETEER_EXECUTABLE_PATH is configured but the file does
 * not exist (Docker image built without Chromium), fail fast with a clear error instead of an
 * opaque launch failure. When unset, Puppeteer's own downloaded browser is used.
 */
function resolveExecutablePath(env = process.env) {
  const configured = env.PUPPETEER_EXECUTABLE_PATH;
  if (!configured) return undefined;
  if (!fs.existsSync(configured)) {
    throw new PdfRendererUnavailableError(
      'Chromium was not found at PUPPETEER_EXECUTABLE_PATH; server-side PDF rendering is unavailable'
    );
  }
  return configured;
}

// Each Chromium launch costs roughly 100-200 MB of RAM (ASSUMED); cap concurrent renders per process.
function readRenderConcurrency() {
  try {
    return getCfg().PDF_RENDER_CONCURRENCY;
  } catch {
    return Math.max(1, parseInt(process.env.PDF_RENDER_CONCURRENCY, 10) || 1);
  }
}
const renderLimit = createLimiter(readRenderConcurrency());

/**
 * Hardened Chromium PDF generator:
 * - JavaScript disabled (no script execution)
 * - Request interception enabled with all requests aborted (zero network egress / SSRF defense)
 * - Deterministic A4 output
 * - Guaranteed browser cleanup in finally block
 *
 * @param {string} htmlContent
 * @returns {Promise<Buffer>}
 */
async function generateHardenedPdf(
  htmlContent,
  { noSandbox = process.env.PUPPETEER_NO_SANDBOX === 'true' } = {}
) {
  const executablePath = resolveExecutablePath();

  return renderLimit(async () => {
    let browser = null;
    try {
      const launchArgs = ['--disable-dev-shm-usage', '--disable-gpu'];
      if (noSandbox) {
        launchArgs.push('--no-sandbox', '--disable-setuid-sandbox');
      }

      try {
        browser = await puppeteer.launch({
          headless: true,
          args: launchArgs,
          ...(executablePath ? { executablePath } : {}),
        });
      } catch (launchErr) {
        const err = new PdfRendererUnavailableError('Chromium failed to launch');
        err.cause = launchErr;
        throw err;
      }

      const page = await browser.newPage();

      // 1. Disable JavaScript execution entirely
      await page.setJavaScriptEnabled(false);

      // 2. Intercept and abort ALL outbound network requests (blocks SSRF / img tag fetches)
      await page.setRequestInterception(true);
      page.on('request', (interceptedRequest) => {
        interceptedRequest.abort();
      });

      // 3. Load HTML
      await page.setContent(htmlContent, { waitUntil: 'load' });

      // 4. Render A4 PDF
      const pdfUint8Array = await page.pdf({
        format: 'A4',
        margin: {
          top: '20mm',
          bottom: '20mm',
          left: '15mm',
          right: '15mm',
        },
        printBackground: true,
      });

      return Buffer.from(pdfUint8Array);
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  });
}

/**
 * Renders a ResumeDraft to a PDF buffer, optionally omitting excluded bullet IDs.
 *
 * @param {object} draft - Validated ResumeDraft
 * @param {object} [options]
 * @param {string[]} [options.excludedBulletIds]
 * @returns {Promise<Buffer>}
 */
async function renderDraftToPdf(draft, options = {}) {
  const html = renderDraftToHtml(draft, options);
  return generateHardenedPdf(html, options);
}

module.exports = {
  generateHardenedPdf,
  renderDraftToPdf,
  resolveExecutablePath,
  PdfRendererUnavailableError,
};
