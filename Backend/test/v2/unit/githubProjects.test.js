import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  defaultProjectName,
  sanitizeDisplayName,
  selectEvidencePack,
  sanitizeBullets,
  applyGithubProjectRules,
  MAX_BULLETS_PER_PROJECT,
} = require('../../../src/v2/core/githubProjects');

describe('core/githubProjects (pure)', () => {
  describe('defaultProjectName', () => {
    it.each([
      ['fun-s-dev/Banking-System-backend', 'Banking System Backend'],
      ['me/meri_sakhi', 'Meri Sakhi'],
      ['me/JobFitAI', 'JobFitAI'], // a name written in camel case is kept as written
      ['me/anvaya-agent', 'Anvaya Agent'],
      ['me/rag-bot-v2', 'Rag Bot V2'],
      ['just-a-repo', 'Just A Repo'],
    ])('%s -> %s', (input, expected) => {
      expect(defaultProjectName(input)).toBe(expected);
    });

    it('falls back for empty input', () => {
      expect(defaultProjectName('')).toBe('Project');
      expect(defaultProjectName(undefined)).toBe('Project');
    });
  });

  describe('sanitizeDisplayName', () => {
    it('collapses whitespace, strips control characters and bounds the length', () => {
      expect(sanitizeDisplayName('  Backend   Ledger \n ')).toBe('Backend Ledger');
      expect(sanitizeDisplayName('a\u0000b\u0007c')).toBe('a b c');
      expect(sanitizeDisplayName('x'.repeat(500))).toHaveLength(100);
      expect(sanitizeDisplayName(null)).toBe('');
    });
  });

  describe('selectEvidencePack', () => {
    const chunk = (id, source, text = id) => ({ id, source, text });
    // Requirement 0 is about axis 0, requirement 1 about axis 1
    const requirements = [{ text: 'Node.js APIs' }, { text: 'RAG' }];
    const requirementVectors = [[1, 0, 0], [0, 1, 0]];
    const items = [
      { chunk: chunk('metadata_chunk_0', 'metadata'), vector: [0, 0, 1] },
      { chunk: chunk('readme_chunk_0', 'readme'), vector: [1, 0, 0] },
      { chunk: chunk('readme_chunk_1', 'readme'), vector: [0, 1, 0] },
      { chunk: chunk('readme_chunk_2', 'readme'), vector: [0, 0, 1] },
      { chunk: chunk('stack_chunk_0', 'dependencies'), vector: [0, 0, 1] },
    ];

    it('picks the README passages that match the job, with description first and stack last', () => {
      const pack = selectEvidencePack({ requirements, requirementVectors, chunkItems: items, minCosine: 0.8, minReadmeChunks: 2 });
      expect(pack.map((c) => c.id)).toEqual(['metadata_chunk_0', 'readme_chunk_0', 'readme_chunk_1', 'stack_chunk_0']);
    });

    it('leaves out README passages that do not match any requirement when there are enough matching ones', () => {
      const pack = selectEvidencePack({ requirements, requirementVectors, chunkItems: items, minCosine: 0.8, minReadmeChunks: 2 });
      expect(pack.map((c) => c.id)).not.toContain('readme_chunk_2');
    });

    it('tops the pack up with the next best passages so the model has enough of the project to write from', () => {
      const pack = selectEvidencePack({ requirements, requirementVectors, chunkItems: items, minCosine: 0.8 }); // default minimum 4
      expect(pack.filter((c) => c.source === 'readme').map((c) => c.id)).toEqual(['readme_chunk_0', 'readme_chunk_1', 'readme_chunk_2']);
    });

    it('puts passages that match the job first, and fills the rest in README order', () => {
      const flat = Array.from({ length: 6 }, (_, i) => ({ chunk: chunk(`readme_chunk_${i}`, 'readme'), vector: [0, 0, 1] }));
      flat[4].vector = [1, 0, 0]; // the only passage about the job
      const pack = selectEvidencePack({ requirements, requirementVectors, chunkItems: flat, minCosine: 0.8, minReadmeChunks: 4 });
      expect(pack.map((c) => c.id)).toEqual(['readme_chunk_4', 'readme_chunk_0', 'readme_chunk_1', 'readme_chunk_2']);
    });

    it('describes the project from its best passages when nothing clears the bar, instead of skipping it', () => {
      const pack = selectEvidencePack({
        requirements,
        requirementVectors: [[0, 0, 0.001], [0, 0, 0.001]],
        chunkItems: items.filter((i) => i.chunk.source !== 'readme' || i.chunk.id !== 'readme_chunk_2'),
        minCosine: 0.99,
        minReadmeChunks: 2,
      });
      expect(pack.filter((c) => c.source === 'readme')).toHaveLength(2);
    });

    it('caps the number of README passages', () => {
      const many = Array.from({ length: 20 }, (_, i) => ({ chunk: chunk(`readme_chunk_${i}`, 'readme'), vector: [1, 0, 0] }));
      const pack = selectEvidencePack({ requirements, requirementVectors, chunkItems: many, perRequirement: 20, maxReadmeChunks: 4 });
      expect(pack.filter((c) => c.source === 'readme')).toHaveLength(4);
    });

    it('returns an empty pack for a repository without any passages', () => {
      expect(selectEvidencePack({ requirements, requirementVectors, chunkItems: [] })).toEqual([]);
    });
  });

  describe('sanitizeBullets', () => {
    const labels = new Map([
      ['E1', { id: 'readme_chunk_0' }],
      ['E2', { id: 'readme_chunk_3' }],
    ]);

    it('maps the cited labels to real chunk ids', () => {
      const out = sanitizeBullets([{ text: 'Built a REST API.', evidence: ['E1', 'e2', 'E1'] }], labels);
      expect(out).toEqual([{ text: 'Built a REST API.', sources: ['readme_chunk_0', 'readme_chunk_3'] }]);
    });

    it('drops bullets that cite nothing real: an uncited or invented citation cannot be traced to the repository', () => {
      const out = sanitizeBullets(
        [
          { text: 'No citation at all.', evidence: [] },
          { text: 'Invented citation.', evidence: ['E9', 'foo'] },
          { text: 'Good one.', evidence: ['E2'] },
        ],
        labels
      );
      expect(out.map((b) => b.text)).toEqual(['Good one.']);
    });

    it('drops empty, over-long and duplicate bullets and keeps at most the limit', () => {
      const ok = (i) => ({ text: `Implemented feature number ${i}.`, evidence: ['E1'] });
      const out = sanitizeBullets(
        [
          { text: '   ', evidence: ['E1'] },
          { text: 'x'.repeat(400), evidence: ['E1'] },
          ok(1),
          { text: 'IMPLEMENTED FEATURE NUMBER 1.', evidence: ['E1'] },
          ok(2),
          ok(3),
          ok(4),
        ],
        labels
      );
      expect(out.map((b) => b.text)).toEqual(['Implemented feature number 1.', 'Implemented feature number 2.', 'Implemented feature number 3.']);
      expect(out).toHaveLength(MAX_BULLETS_PER_PROJECT);
    });

    it('tolerates malformed model output', () => {
      expect(sanitizeBullets(undefined, labels)).toEqual([]);
      expect(sanitizeBullets([null, {}, { text: 5, evidence: 'E1' }], labels)).toEqual([]);
    });
  });

  describe('applyGithubProjectRules', () => {
    const draft = {
      projects: [
        { id: 'prj0', name: 'Banking System Backend', source: 'github', analysisId: 'a1' },
        { id: 'prj1', name: 'Anvaya Agent', source: 'github', analysisId: 'a2' },
        { id: 'prj2', name: 'Old Resume Project' }, // resume-sourced: untouched by these rules
      ],
    };
    const exportDraft = {
      projects: [
        { id: 'prj0', name: 'Banking System Backend', bullets: [{ id: 'prj0.b0', text: 'x' }] },
        { id: 'prj1', name: 'Anvaya Agent', bullets: [{ id: 'prj1.b0', text: 'y' }] },
        { id: 'prj2', name: 'Old Resume Project', bullets: [{ id: 'prj2.b0', text: 'z' }] },
      ],
      skills: ['Node.js'],
    };

    it('exports a confirmed project under the name the user chose', () => {
      const { exportDraft: out, excludedItems } = applyGithubProjectRules({
        draft,
        exportDraft,
        links: [
          { analysisId: 'a1', displayName: 'Backend Ledger', authorshipConfirmedAt: new Date() },
          { analysisId: 'a2', displayName: null, authorshipConfirmedAt: new Date() },
        ],
      });
      expect(out.projects.map((p) => p.name)).toEqual(['Backend Ledger', 'Anvaya Agent', 'Old Resume Project']);
      expect(excludedItems).toEqual([]);
      expect(out.skills).toEqual(['Node.js']); // everything else is untouched
    });

    it('keeps a project out until the user confirmed they built it, and says why', () => {
      const { exportDraft: out, excludedItems } = applyGithubProjectRules({
        draft,
        exportDraft,
        links: [
          { analysisId: 'a1', displayName: 'Backend Ledger', authorshipConfirmedAt: null },
          { analysisId: 'a2', authorshipConfirmedAt: new Date() },
        ],
      });
      expect(out.projects.map((p) => p.id)).toEqual(['prj1', 'prj2']);
      expect(excludedItems).toHaveLength(1);
      expect(excludedItems[0]).toMatchObject({ section: 'projects', text: 'Backend Ledger' });
      expect(excludedItems[0].reason).toMatch(/Confirm that you built "Backend Ledger".*does not show that you wrote its code/);
    });

    it('treats a missing link as unconfirmed (fail closed)', () => {
      const { exportDraft: out } = applyGithubProjectRules({ draft, exportDraft, links: [] });
      expect(out.projects.map((p) => p.id)).toEqual(['prj2']);
    });

    it('does not touch drafts without GitHub projects', () => {
      const plain = { projects: [{ id: 'prj0', name: 'A' }] };
      const exp = { projects: [{ id: 'prj0', name: 'A', bullets: [] }] };
      const { exportDraft: out, excludedItems } = applyGithubProjectRules({ draft: plain, exportDraft: exp, links: [] });
      expect(out.projects).toEqual(exp.projects);
      expect(excludedItems).toEqual([]);
    });
  });
});
