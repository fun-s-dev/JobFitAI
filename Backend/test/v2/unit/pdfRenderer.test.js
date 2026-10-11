import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { escapeHtml, renderDraftToHtml } = require('../../../src/v2/templates/resumePdfTemplate');
const { renderDraftToPdf } = require('../../../src/v2/adapters/pdfRenderer');

describe('adapters/pdfRenderer & templates/resumePdfTemplate', () => {
  const sampleDraft = {
    summary: 'Senior Full Stack Engineer.',
    experience: [
      {
        id: 'exp0',
        company: 'Acme Corp',
        role: 'Tech Lead',
        dates: '2021 - Present',
        bullets: [
          { id: 'exp0.b0', text: 'Architected microservices in Node.js.' },
          { id: 'exp0.b1', text: 'Malicious payload <script>alert("xss")</script> and <img src="http://attacker.com/leak" />' },
          { id: 'exp0.b2', text: 'Scaled system by 40% with Redis.' },
        ],
      },
    ],
    projects: [
      {
        id: 'prj0',
        name: 'JobFitAI',
        bullets: [
          { id: 'prj0.b0', text: 'Built resume verification pipeline.' },
        ],
      },
    ],
    skills: ['Node.js', 'Express', 'React'],
    education: [
      {
        id: 'edu0',
        school: 'State University',
        degree: 'B.S. Computer Science',
        dates: '2017 - 2021',
      },
    ],
  };

  it('escapes &, <, >, and quotes in interpolated HTML strings', () => {
    expect(escapeHtml('Hello & <World> "quotes" \'apostrophe\'')).toBe(
      'Hello &amp; &lt;World&gt; &quot;quotes&quot; &#39;apostrophe&#39;'
    );
  });

  it('escapes script and img tags in bullet text to prevent XSS and SSRF', () => {
    const html = renderDraftToHtml(sampleDraft);

    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).not.toContain('<img src="http://attacker.com/leak" />');

    expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=&quot;http://attacker.com/leak&quot; /&gt;');
  });

  it('renders bullets with explicit data-bullet-id attributes', () => {
    const html = renderDraftToHtml(sampleDraft);
    expect(html).toContain('data-bullet-id="exp0.b0"');
    expect(html).toContain('data-bullet-id="exp0.b1"');
    expect(html).toContain('data-bullet-id="prj0.b0"');
  });

  it('surgically excludes specified bullet IDs from rendered HTML', () => {
    const html = renderDraftToHtml(sampleDraft, {
      excludedBulletIds: ['exp0.b1', 'prj0.b0'],
    });

    expect(html).toContain('data-bullet-id="exp0.b0"');
    expect(html).not.toContain('data-bullet-id="exp0.b1"');
    expect(html).not.toContain('data-bullet-id="prj0.b0"');
    expect(html).toContain('data-bullet-id="exp0.b2"');
  });

  it('renders a real A4 PDF buffer from the structured draft via Puppeteer', async () => {
    const pdfBuffer = await renderDraftToPdf(sampleDraft, {
      excludedBulletIds: ['exp0.b1'],
    });

    expect(Buffer.isBuffer(pdfBuffer)).toBe(true);
    expect(pdfBuffer.length).toBeGreaterThan(1000);
    // PDF magic bytes: %PDF-
    const header = pdfBuffer.subarray(0, 5).toString('ascii');
    expect(header).toBe('%PDF-');
  }, 20000); // 20s timeout for Chromium launch

  it('renders HTML with <img src="http://127.0.0.1:PORT"> and <script> against a throwaway local HTTP server and asserts ZERO requests were received', async () => {
    const http = require('node:http');
    const receivedRequests = [];

    const server = http.createServer((req, res) => {
      receivedRequests.push(req.url);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const exploitDraft = {
        summary: 'Security testing summary.',
        experience: [
          {
            id: 'exp0',
            company: 'SecurityLab',
            role: 'Tester',
            dates: '2022',
            bullets: [
              {
                id: 'exp0.b0',
                text: `Probe payload: <img src="http://127.0.0.1:${port}/ssrf-attempt.png"> and <script>fetch("http://127.0.0.1:${port}/xss-attempt");</script>`,
              },
            ],
          },
        ],
        projects: [],
        skills: ['Security'],
        education: [],
      };

      const pdfBuffer = await renderDraftToPdf(exploitDraft);
      expect(Buffer.isBuffer(pdfBuffer)).toBe(true);
      expect(pdfBuffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');

      // Assert that ZERO requests reached the local server (request interception blocked network egress and JS was disabled)
      expect(receivedRequests.length).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, 20000);
});

