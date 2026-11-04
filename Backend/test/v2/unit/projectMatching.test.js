import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizeProjectKey,
  projectIndexFromBulletId,
  autoMatchProjectIndex,
  resolveProjectForRepo,
} = require('../../../src/v2/core/projectMatching');

const projects = (...names) => names.map((name) => ({ name }));

describe('core/projectMatching (pure)', () => {
  describe('normalizeProjectKey', () => {
    it('ignores case, spaces, dashes, underscores and dots', () => {
      expect(normalizeProjectKey('Meri-Sakhi')).toBe('merisakhi');
      expect(normalizeProjectKey('meri_sakhi')).toBe('merisakhi');
      expect(normalizeProjectKey(' Meri Sakhi ')).toBe('merisakhi');
      expect(normalizeProjectKey(null)).toBe('');
    });
  });

  describe('projectIndexFromBulletId', () => {
    it('reads the project index of project bullets only', () => {
      expect(projectIndexFromBulletId('prj0.b0')).toBe(0);
      expect(projectIndexFromBulletId('prj12.b3')).toBe(12);
      expect(projectIndexFromBulletId('exp0.b0')).toBeNull();
      expect(projectIndexFromBulletId('prj1')).toBeNull();
      expect(projectIndexFromBulletId(undefined)).toBeNull();
    });
  });

  describe('autoMatchProjectIndex', () => {
    it('matches a repository to the project with the same name, ignoring the owner and punctuation', () => {
      expect(autoMatchProjectIndex('fun-s-dev/JobFitAI', projects('Meri Sakhi', 'JobFitAI'))).toBe(1);
      expect(autoMatchProjectIndex('fun-s-dev/meri-sakhi', projects('Meri Sakhi', 'JobFitAI'))).toBe(0);
    });

    it('matches when one name contains the other (at least 5 characters)', () => {
      expect(autoMatchProjectIndex('a/jobfitai-v2', projects('JobFitAI'))).toBe(0);
    });

    it('does not match unrelated names, even when they share technology words', () => {
      expect(autoMatchProjectIndex('fun-s-dev/anvaya-agent', projects('Meri Sakhi', 'Backend Ledger', 'JobFitAI'))).toBe(-1);
      expect(autoMatchProjectIndex('fun-s-dev/Banking-System-backend', projects('Backend Ledger'))).toBe(-1);
    });

    it('does not treat very short names as a containment match', () => {
      expect(autoMatchProjectIndex('a/api', projects('My API Server'))).toBe(-1);
    });

    it('does not guess when several projects match equally well', () => {
      expect(autoMatchProjectIndex('a/jobfit', projects('JobFit Alpha', 'JobFit Beta'))).toBe(-1);
      expect(autoMatchProjectIndex('a/Same', projects('Same', 'same'))).toBe(-1);
    });

    it('prefers the exact match over a partial one', () => {
      expect(autoMatchProjectIndex('a/jobfitai', projects('JobFitAI Platform', 'JobFitAI'))).toBe(1);
    });

    it('handles empty input', () => {
      expect(autoMatchProjectIndex('', projects('X Project'))).toBe(-1);
      expect(autoMatchProjectIndex('a/b', [])).toBe(-1);
      expect(autoMatchProjectIndex('a/b', undefined)).toBe(-1);
    });
  });

  describe('resolveProjectForRepo', () => {
    const list = projects('Meri Sakhi', 'Backend Ledger');

    it('uses the explicit choice first, even over a matching name', () => {
      expect(
        resolveProjectForRepo({ explicitProjectName: 'Backend Ledger', repositoryFullName: 'a/meri-sakhi', projects: list })
      ).toEqual({ index: 1, source: 'user' });
    });

    it('falls back to the name match when there is no explicit choice', () => {
      expect(resolveProjectForRepo({ repositoryFullName: 'a/meri-sakhi', projects: list })).toEqual({
        index: 0,
        source: 'name',
      });
    });

    it('reports no match when nothing fits', () => {
      expect(resolveProjectForRepo({ repositoryFullName: 'a/anvaya-agent', projects: list })).toEqual({
        index: -1,
        source: 'none',
      });
    });

    it('treats an explicit choice that is no longer in the draft as unmatched instead of guessing', () => {
      expect(
        resolveProjectForRepo({ explicitProjectName: 'Gone', repositoryFullName: 'a/meri-sakhi', projects: list })
      ).toEqual({ index: -1, source: 'none' });
    });
  });
});
