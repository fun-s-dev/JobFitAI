import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { renderDraftToHtml, safeHref } = require('../../../src/v2/templates/resumePdfTemplate');
const { splitProjectHeading, assignDraftIds } = require('../../../src/v2/schemas/resumeDraft');
const { groundDraftSections } = require('../../../src/v2/core/sectionGrounding');
const { buildGroundedExport } = require('../../../src/v2/core/groundedExport');

describe('resume template: links, certifications, grade, project tech', () => {
  const base = {
    name: 'Riley Tester',
    contact: ['+1 555 0100', 'riley@example.com'],
    links: [
      { label: 'LinkedIn', url: 'https://www.linkedin.com/in/riley-test' },
      { label: 'GitHub', url: 'https://github.com/riley-test' },
    ],
    summary: '',
    experience: [],
    projects: [
      {
        id: 'prj0',
        name: 'Backend Ledger',
        tech: ['Node.js', 'MongoDB'],
        url: 'https://github.com/riley-test/ledger',
        bullets: [{ id: 'prj0.b0', text: 'Implemented immutable ledger records.' }],
      },
    ],
    skills: [],
    education: [{ id: 'edu0', school: 'Sample University', degree: 'B.Tech', dates: '2024 - Present', grade: 'CGPA: 9.20 (till sem IV)' }],
    certifications: [
      { text: 'Completed Python for Data Science by NPTEL [Certificate]', links: [{ label: '[Certificate]', url: 'https://nptel.ac.in/cert/123' }] },
      { text: 'Solved 200+ problems.', links: [] },
    ],
  };

  it('renders the profile links as real hyperlinks next to the contact details', () => {
    const html = renderDraftToHtml(base);
    expect(html).toContain('<a href="https://www.linkedin.com/in/riley-test" target="_blank" rel="noopener noreferrer">LinkedIn</a>');
    expect(html).toContain('<a href="https://github.com/riley-test"');
    expect(html).toMatch(/riley@example\.com[^<]*&nbsp;\|&nbsp;[^<]*<a href="https:\/\/www\.linkedin/);
  });

  it('renders a project with its name, tech list and repository link', () => {
    const html = renderDraftToHtml(base);
    expect(html).toContain('<strong>Backend Ledger</strong> <span class="entry-tech">| Node.js, MongoDB</span>');
    expect(html).toContain('<a href="https://github.com/riley-test/ledger" target="_blank" rel="noopener noreferrer">GitHub</a>');
  });

  it('renders the grade under the education entry', () => {
    expect(renderDraftToHtml(base)).toContain('<div class="entry-sub">CGPA: 9.20 (till sem IV)</div>');
  });

  it('renders certifications with their link once (the label is not repeated)', () => {
    const html = renderDraftToHtml(base);
    expect(html).toContain('<h2>Certifications &amp; Achievements</h2>');
    expect(html).toContain('<li>Completed Python for Data Science by NPTEL <a href="https://nptel.ac.in/cert/123"');
    expect(html.match(/\[Certificate\]/g)).toHaveLength(1);
    expect(html).toContain('<li>Solved 200+ problems.</li>');
  });

  it('omits the new sections entirely when there is nothing to show', () => {
    const html = renderDraftToHtml({ name: 'A', contact: [], experience: [], projects: [], skills: [], education: [] });
    expect(html).not.toContain('<h2>Certifications');
    expect(html).not.toContain('<span class="entry-tech">');
    expect(html).not.toContain('<a ');
  });

  describe('safety', () => {
    it('only web URLs become links; anything else is shown as plain escaped text', () => {
      const html = renderDraftToHtml({
        ...base,
        links: [
          { label: 'Evil', url: 'javascript:alert(1)' },
          { label: 'Data', url: 'data:text/html,<script>alert(1)</script>' },
          { label: 'Creds', url: 'https://user:pass@evil.example/' },
        ],
        projects: [{ ...base.projects[0], url: 'javascript:alert(2)' }],
      });
      expect(html).not.toMatch(/href="javascript:/i);
      expect(html).not.toMatch(/href="data:/i);
      expect(html).not.toContain('user:pass');
      expect(html).toContain('Evil');
      expect(html).not.toContain('alert(2)');
    });

    it('escapes HTML in labels, certifications, tech and grade', () => {
      const html = renderDraftToHtml({
        ...base,
        links: [{ label: '<img src=x onerror=alert(1)>', url: 'https://ok.example/' }],
        certifications: [{ text: '<script>alert(3)</script>', links: [] }],
        projects: [{ ...base.projects[0], tech: ['<b>bold</b>'] }],
        education: [{ ...base.education[0], grade: '<i>9</i>' }],
      });
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('<img');
      expect(html).not.toContain('<b>bold');
      expect(html).not.toContain('<i>9');
      expect(html).toContain('&lt;script&gt;');
    });

    it('escapes quotes in URLs so they cannot break out of the attribute', () => {
      const href = safeHref('https://ok.example/a"onmouseover="alert(1)');
      expect(href).not.toContain('"onmouseover');
      expect(safeHref('not a url')).toBeNull();
    });
  });
});

describe('project headings: "Name | tech, tech" is split into name and tech', () => {
  it.each([
    ['JobFitAI | React, Node.js, Express.js, MongoDB, Gemini AI', 'JobFitAI', ['React', 'Node.js', 'Express.js', 'MongoDB', 'Gemini AI']],
    ['Meri Sakhi | FastAPI, Python, SQLite | GitHub', 'Meri Sakhi', ['FastAPI', 'Python', 'SQLite']],
    ['Plain Name', 'Plain Name', []],
    ['  Spaced  |  A ; B  ', 'Spaced', ['A', 'B']],
    ['| leading bar', '| leading bar', []],
  ])('%j', (input, name, tech) => {
    expect(splitProjectHeading(input)).toEqual({ name, tech });
  });

  it('assigns the clean name and the tech list to the draft, leaving ids and bullets alone', () => {
    const draft = assignDraftIds({
      projects: [
        { name: 'Backend Ledger | Node.js, MongoDB', bullets: ['Built transfers.'] },
        { name: 'No Tech Project', bullets: [{ text: 'Did a thing.' }] },
      ],
    });
    expect(draft.projects[0]).toEqual({ id: 'prj0', name: 'Backend Ledger', tech: ['Node.js', 'MongoDB'], bullets: [{ id: 'prj0.b0', text: 'Built transfers.' }] });
    expect(draft.projects[1]).toEqual({ id: 'prj1', name: 'No Tech Project', bullets: [{ id: 'prj1.b0', text: 'Did a thing.' }] }); // no empty tech field
  });
});

describe('project tech grounding in the export', () => {
  const evidence = ['Backend Ledger. Node.js, Express.js, MongoDB, Mongoose, JWT. Built a banking backend.'];
  const draft = {
    summary: '',
    projects: [
      { id: 'prj0', name: 'Backend Ledger', tech: ['Node.js', 'MongoDB', 'Kubernetes'], bullets: [{ id: 'prj0.b0', text: 'x' }] },
      { id: 'prj1', name: 'Written From GitHub', source: 'github', tech: ['Rust', 'Tokio'], bullets: [{ id: 'prj1.b0', text: 'y' }] },
    ],
    experience: [],
    skills: [],
    education: [],
  };

  it('keeps a resume project’s technologies only when the resume says them, and lists the dropped ones', () => {
    const out = groundDraftSections(draft, evidence);
    expect(out.projectTech.prj0).toEqual(['Node.js', 'MongoDB']);
    expect(out.excludedItems.find((i) => i.section === 'projects')).toMatchObject({
      text: 'Backend Ledger: Kubernetes',
      reason: 'Technology not found in your resume or self-description.',
    });
  });

  it('keeps a GitHub project’s technologies (they come from the repository’s own code, not the resume)', () => {
    expect(groundDraftSections(draft, evidence).projectTech.prj1).toEqual(['Rust', 'Tokio']);
  });

  it('carries the grounded tech into the export draft', () => {
    const claims = [
      { bulletId: 'prj0.b0', claimText: 'x', status: 'verified' },
      { bulletId: 'prj1.b0', claimText: 'y', status: 'verified' },
    ];
    const { exportDraft } = buildGroundedExport(draft, claims, evidence);
    expect(exportDraft.projects.find((p) => p.id === 'prj0').tech).toEqual(['Node.js', 'MongoDB']);
    expect(exportDraft.projects.find((p) => p.id === 'prj1').tech).toEqual(['Rust', 'Tokio']);
  });

  it('does not warn that a cleaned-up project name is missing from the resume', () => {
    const out = groundDraftSections(draft, evidence);
    expect(out.warnings.filter((w) => w.entryId === 'prj0')).toEqual([]);
  });
});
