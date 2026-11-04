import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizeForMatch,
  buildEvidenceIndex,
  containsPhrase,
  isSkillGrounded,
  groundDraftSections,
} = require('../../../src/v2/core/sectionGrounding');

// Synthetic evidence only (no real resume data)
const RESUME = [
  'Jane Example',
  'jane.example@example.com | +1 555 010 0199 | Springfield',
  'github.com/jane-example',
  'Software Engineer, Acme Corporation, 2021 - 2024',
  '- Built REST APIs with Node.js, Express and PostgreSQL.',
  '- Wrote unit tests in Jest. Some C++ tooling.',
  'Education: Bachelor of Science in Computer Science, Springfield State University',
].join('\n');

describe('core/sectionGrounding: matching primitives', () => {
  it('normalizes punctuation but keeps + and # so C++ and C# stay distinct', () => {
    expect(normalizeForMatch('Node.js, C++ & C#!')).toBe('node js c++ c#');
  });

  it('matches whole phrases on token boundaries only', () => {
    const index = buildEvidenceIndex([RESUME]);
    expect(containsPhrase(index, 'Acme Corporation')).toBe(true);
    expect(containsPhrase(index, 'Acme Corp')).toBe(false); // "corp" is not a whole token
    expect(containsPhrase(index, 'C')).toBe(false); // "C++" must not ground plain "C"
    expect(containsPhrase(index, 'C++')).toBe(true);
    expect(containsPhrase(index, '')).toBe(false);
  });

  it('grounds skills directly, through aliases, and rejects absent skills', () => {
    const aliasMap = { 'postgres': 'PostgreSQL', 'postgresql': 'PostgreSQL', 'k8s': 'Kubernetes', 'kubernetes': 'Kubernetes' };
    const reverse = new Map([['postgresql', ['postgres', 'postgresql']], ['kubernetes', ['k8s', 'kubernetes']]]);
    const index = buildEvidenceIndex([RESUME]);

    expect(isSkillGrounded('Node.js', index, aliasMap, reverse)).toBe(true);
    expect(isSkillGrounded('Postgres', index, aliasMap, reverse)).toBe(true); // alias of PostgreSQL
    expect(isSkillGrounded('Kubernetes', index, aliasMap, reverse)).toBe(false);
  });
});

describe('core/sectionGrounding: groundDraftSections', () => {
  const draft = {
    name: 'Jane Example',
    contact: ['jane.example@example.com', '+1 555 010 0199', 'linkedin.com/in/invented-profile'],
    summary: 'Seasoned engineer who led a team of 12.',
    experience: [
      { id: 'exp0', company: 'Acme Corporation', role: 'Software Engineer', dates: '2021 - 2024', bullets: [] },
      { id: 'exp1', company: 'Acme Corporation', role: 'Principal Architect', dates: '', bullets: [] },
    ],
    projects: [{ id: 'prj0', name: 'Quantum Ledger', bullets: [] }],
    skills: ['Node.js', 'Express', 'Kubernetes', 'Jest'],
    education: [
      { id: 'edu0', school: 'Springfield State University', degree: 'Bachelor of Science in Computer Science', dates: '' },
      { id: 'edu1', school: 'Springfield State University', degree: 'Master of Science in Data Science', dates: '' },
      { id: 'edu2', school: 'Invented Institute', degree: 'Bachelor of Science in Computer Science', dates: '' },
    ],
  };

  it('always excludes the AI-written summary with a reason', () => {
    const result = groundDraftSections(draft, [RESUME]);
    const summaryItem = result.excludedItems.find((i) => i.section === 'summary');
    expect(summaryItem).toBeDefined();
    expect(summaryItem.reason).toMatch(/not checked claim by claim/);
  });

  it('keeps name and contact lines found in the resume and drops invented ones', () => {
    const result = groundDraftSections(draft, [RESUME]);
    expect(result.header.name).toBe('Jane Example');
    expect(result.header.contact).toEqual(['jane.example@example.com', '+1 555 010 0199']);
    expect(result.excludedItems).toContainEqual(
      expect.objectContaining({ section: 'header', text: 'linkedin.com/in/invented-profile' })
    );
  });

  it('keeps only skills present in the evidence', () => {
    const result = groundDraftSections(draft, [RESUME]);
    expect(result.skills).toEqual(['Node.js', 'Express', 'Jest']);
    expect(result.excludedItems).toContainEqual(
      expect.objectContaining({ section: 'skills', text: 'Kubernetes' })
    );
  });

  it('treats self-description as user-supplied evidence', () => {
    const result = groundDraftSections(draft, [RESUME, 'I also run Kubernetes clusters at home.']);
    expect(result.skills).toContain('Kubernetes');
  });

  it('requires both school and the full degree wording for education', () => {
    const result = groundDraftSections(draft, [RESUME]);
    expect(result.educationIds).toEqual(['edu0']);
    const reasons = result.excludedItems.filter((i) => i.section === 'education').map((i) => i.reason);
    expect(reasons).toContain('Degree wording not found in your resume.'); // edu1: inflated degree
    expect(reasons).toContain('School not found in your resume.'); // edu2: invented school
  });

  it('warns (without excluding) about job titles and project names not in the resume', () => {
    const result = groundDraftSections(draft, [RESUME]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ section: 'experience', entryId: 'exp1', text: 'Principal Architect' })
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ section: 'projects', entryId: 'prj0', text: 'Quantum Ledger' })
    );
    expect(result.warnings.find((w) => w.entryId === 'exp0')).toBeUndefined();
  });

  it('handles drafts created before header fields existed', () => {
    const legacy = { summary: '', experience: [], projects: [], skills: [], education: [] };
    const result = groundDraftSections(legacy, [RESUME]);
    expect(result.header).toEqual({ name: '', contact: [] });
    expect(result.excludedItems).toEqual([]);
  });
});
