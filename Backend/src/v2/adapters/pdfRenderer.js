const puppeteer = require('puppeteer');
const { renderDraftToHtml } = require('../templates/resumePdfTemplate');

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
  let browser = null;
  try {
    const launchArgs = ['--disable-dev-shm-usage', '--disable-gpu'];
    if (noSandbox) {
      launchArgs.push('--no-sandbox', '--disable-setuid-sandbox');
    }

    browser = await puppeteer.launch({
      headless: 'new',
      args: launchArgs,
    });


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
};
