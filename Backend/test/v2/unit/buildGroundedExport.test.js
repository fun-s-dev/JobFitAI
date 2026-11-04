import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildGroundedExport } = require('../../../src/v2/core/groundedExport');
const { renderDraftToHtml } = require('../../../src/v2/templates/resumePdfTemplate');

const RESUME = 'Sam Sample\nsam@example.com\nBackend Developer at Example Labs\nNode.js, Redis\nBSc Physics, Example University';

const draft = {
  name: 'Sam Sample',
  contact: ['sam@example.com'],
  summary: 'Visionary leader of 50 engineers.',
  experience: [
    {
      id: 'exp0',
      company: 'Example Labs',
      role: 'Backend Developer',
      dates: '2022',
      bullets: [
        { id: 'exp0.b0', text: 'Built caching with Redis.' },
        { id: 'exp0.b1', text: 'Cut costs by 90%.' },
      ],
    },
    {
      id: 'exp1',
      company: 'Example Labs',
      role: 'Backend Developer',
      dates: '2021',
      bullets: [{ id: 'exp1.b0', text: 'Fabricated achievement.' }],
    },
  ],
  projects: [],
  skills: ['Node.js', 'Redis', 'Rust'],
  education: [{ id: 'edu0', school: 'Example University', degree: 'BSc Physics', dates: '' }],
};

const claims = [
  { bulletId: 'exp0.b0', claimText: 'Built caching with Redis', status: 'verified', userOverride: null },
  { bulletId: 'exp0.b1', claimText: 'Cut costs by 90%', status: 'rejected', userOverride: null },
  { bulletId: 'exp1.b0', claimText: 'Fabricated achievement', status: 'needs_review', userOverride: null },
];

describe('core/groundedExport: buildGroundedExport', () => {
  it('produces an export draft containing only grounded content', () => {
    const result = buildGroundedExport(draft, claims, [RESUME, '']);
    const exp = result.exportDraft;

    expect(exp.name).toBe('Sam Sample');
    expect(exp.contact).toEqual(['sam@example.com']);
    expect(exp.summary).toBe('');
    expect(exp.skills).toEqual(['Node.js', 'Redis']);
    expect(exp.education.map((e) => e.id)).toEqual(['edu0']);

    // Only the verified bullet survives; an entry with no surviving bullets is dropped
    expect(exp.experience).toHaveLength(1);
    expect(exp.experience[0].bullets).toEqual([{ id: 'exp0.b0', text: 'Built caching with Redis.' }]);

    expect(result.excludedBulletIds).toEqual(['exp0.b1', 'exp1.b0']);
    expect(result.excludedItems.map((i) => i.section).sort()).toEqual(['skills', 'summary']);
  });

  it('excludes every bullet when there are no claims (no verification run yet)', () => {
    const result = buildGroundedExport(draft, [], [RESUME]);
    expect(result.exportDraft.experience).toEqual([]);
    expect(result.allowedBulletIds).toEqual([]);
  });

  it('honours user approval of a claim the pipeline did not verify', () => {
    const approved = claims.map((c) =>
      c.bulletId === 'exp0.b1' ? { ...c, userOverride: { decision: 'approved' } } : c
    );
    const result = buildGroundedExport(draft, approved, [RESUME]);
    expect(result.allowedBulletIds).toContain('exp0.b1');
  });

  it('renders the export draft with header, without summary and without excluded content', () => {
    const { exportDraft } = buildGroundedExport(draft, claims, [RESUME]);
    const html = renderDraftToHtml(exportDraft);

    expect(html).toContain('<h1 class="resume-name">Sam Sample</h1>');
    expect(html).toContain('<title>Sam Sample - Resume</title>');
    expect(html).toContain('sam@example.com');
    expect(html).not.toContain('Visionary leader');
    expect(html).not.toContain('Professional Summary');
    expect(html).not.toContain('Cut costs by 90%');
    expect(html).not.toContain('Fabricated achievement');
    expect(html).not.toContain('Rust');
  });

  it('escapes header fields', () => {
    const html = renderDraftToHtml({ name: '<script>x</script>', contact: ['"><img src=x>'] });
    expect(html).not.toContain('<script>x</script>');
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });
});
