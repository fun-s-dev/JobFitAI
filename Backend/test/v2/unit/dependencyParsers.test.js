import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parsePackageJson,
  parseRequirementsTxt,
  extractDependenciesFromContent,
  NPM_SKILL_MAP,
  PY_SKILL_MAP,
} = require('../../../src/v2/core/dependencyParsers');

describe('core/dependencyParsers (pure)', () => {
  describe('dependency-to-skill maps', () => {
    it('ensures no dependency has strength greater than 0.5', () => {
      for (const mappings of Object.values(NPM_SKILL_MAP)) {
        for (const mapping of mappings) {
          expect(mapping.strength).toBeLessThanOrEqual(0.5);
          expect(mapping.strength).toBeGreaterThan(0);
          expect(typeof mapping.skill).toBe('string');
        }
      }

      for (const mappings of Object.values(PY_SKILL_MAP)) {
        for (const mapping of mappings) {
          expect(mapping.strength).toBeLessThanOrEqual(0.5);
          expect(mapping.strength).toBeGreaterThan(0);
          expect(typeof mapping.skill).toBe('string');
        }
      }
    });
  });

  describe('parsePackageJson', () => {
    it('parses valid package.json and extracts dependencies & mapped skills', () => {
      const packageJsonStr = JSON.stringify({
        name: 'sample-project',
        dependencies: {
          express: '^4.18.2',
          mongoose: '^7.0.0',
          jsonwebtoken: '^9.0.0',
          redis: '^4.6.0',
        },
        devDependencies: {
          vitest: '^1.0.0',
          supertest: '^6.3.0',
        },
      });

      const result = parsePackageJson(packageJsonStr, 'package.json');
      expect(result.dependencies.length).toBe(6);

      const depNames = result.dependencies.map((d) => d.name);
      expect(depNames).toContain('express');
      expect(depNames).toContain('mongoose');
      expect(depNames).toContain('vitest');

      const skills = result.evidenceItems.map((e) => e.skill);
      expect(skills).toContain('Express');
      expect(skills).toContain('REST APIs');
      expect(skills).toContain('MongoDB');
      expect(skills).toContain('Mongoose');
      expect(skills).toContain('JWT Authentication');
      expect(skills).toContain('Redis');
      expect(skills).toContain('Unit Testing');
      expect(skills).toContain('API Testing');

      for (const item of result.evidenceItems) {
        expect(item.type).toBe('dependency');
        expect(item.strength).toBeLessThanOrEqual(0.5);
        expect(item.sourcePath).toBe('package.json');
        expect(item.contradiction).toBe(false);
      }
    });

    it('handles malformed package.json gracefully without crashing', () => {
      const result = parsePackageJson('{ invalid json: true ', 'package.json');
      expect(result.dependencies).toEqual([]);
      expect(result.evidenceItems).toEqual([]);
    });

    it('handles missing dependencies / devDependencies sections', () => {
      const result = parsePackageJson(JSON.stringify({ name: 'empty-pkg' }), 'package.json');
      expect(result.dependencies).toEqual([]);
      expect(result.evidenceItems).toEqual([]);
    });
  });

  describe('parseRequirementsTxt', () => {
    it('parses valid requirements.txt with versions, comments, and flags', () => {
      const reqContent = `
# Core web framework
flask==2.2.3
fastapi>=0.95.0
pymongo~=4.3.3
pyjwt==2.6.0

# Asynchronous & queues
redis==4.5.4
celery>=5.2.7

# Testing
pytest==7.2.2
-i https://pypi.org/simple
--extra-index-url https://example.com/pypi
# comment line
      `;

      const result = parseRequirementsTxt(reqContent, 'requirements.txt');
      expect(result.dependencies.length).toBe(7);

      const skills = result.evidenceItems.map((e) => e.skill);
      expect(skills).toContain('Flask');
      expect(skills).toContain('FastAPI');
      expect(skills).toContain('REST APIs');
      expect(skills).toContain('MongoDB');
      expect(skills).toContain('JWT Authentication');
      expect(skills).toContain('Redis');
      expect(skills).toContain('Unit Testing');

      for (const item of result.evidenceItems) {
        expect(item.type).toBe('dependency');
        expect(item.strength).toBeLessThanOrEqual(0.5);
        expect(item.sourcePath).toBe('requirements.txt');
      }
    });

    it('handles empty or comment-only requirements.txt gracefully', () => {
      const result = parseRequirementsTxt('# Just comments\n\n# More comments', 'requirements.txt');
      expect(result.dependencies).toEqual([]);
      expect(result.evidenceItems).toEqual([]);
    });
  });

  describe('extractDependenciesFromContent dispatcher', () => {
    it('dispatches package.json correctly', () => {
      const result = extractDependenciesFromContent(
        'backend/package.json',
        JSON.stringify({ dependencies: { express: '^4.18.0' } })
      );
      expect(result.dependencies[0].name).toBe('express');
      expect(result.evidenceItems.some((e) => e.skill === 'Express')).toBe(true);
    });

    it('dispatches requirements.txt correctly', () => {
      const result = extractDependenciesFromContent(
        'requirements.txt',
        'flask>=2.0.0\npytest==7.0.0'
      );
      expect(result.dependencies.map((d) => d.name)).toEqual(['flask', 'pytest']);
    });

    it('returns empty results for unsupported manifest formats', () => {
      const result = extractDependenciesFromContent('pom.xml', '<project></project>');
      expect(result.dependencies).toEqual([]);
      expect(result.evidenceItems).toEqual([]);
    });
  });
});
