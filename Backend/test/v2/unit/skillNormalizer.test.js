import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeSkill } = require('../../../src/v2/core/skillNormalizer');
const skillAliases = require('../../../src/v2/data/skillAliases.json');

describe('core/skillNormalizer', () => {
  it('normalizes common aliases to canonical names', () => {
    expect(normalizeSkill('node')).toBe('Node.js');
    expect(normalizeSkill('nodejs')).toBe('Node.js');
    expect(normalizeSkill('Node.js')).toBe('Node.js');
    expect(normalizeSkill('NODE.JS')).toBe('Node.js');

    expect(normalizeSkill('postgres')).toBe('PostgreSQL');
    expect(normalizeSkill('psql')).toBe('PostgreSQL');
    expect(normalizeSkill('PostgreSQL')).toBe('PostgreSQL');

    expect(normalizeSkill('k8s')).toBe('Kubernetes');
    expect(normalizeSkill('kubernetes')).toBe('Kubernetes');
  });

  it('tolerates leading/trailing whitespace and punctuation', () => {
    expect(normalizeSkill('  react.js  ')).toBe('React');
    expect(normalizeSkill('express,')).toBe('Express');
    expect(normalizeSkill('docker;')).toBe('Docker');
    expect(normalizeSkill('  c++  ')).toBe('C++');
  });

  it('preserves unknown skills with trimmed and whitespace-collapsed text in original casing', () => {
    expect(normalizeSkill('  Quantum   Computing  ')).toBe('Quantum Computing');
    expect(normalizeSkill('CustomInternalLib')).toBe('CustomInternalLib');
    expect(normalizeSkill('')).toBe('');
    expect(normalizeSkill(null)).toBe('');
    expect(normalizeSkill(undefined)).toBe('');
  });

  it('every canonical skill is also a key in skillAliases.json (idempotence guarantee)', () => {
    const canonicalValues = new Set(Object.values(skillAliases));
    for (const canonical of canonicalValues) {
      expect(skillAliases).toHaveProperty(canonical.toLowerCase());
      expect(skillAliases[canonical.toLowerCase()]).toBe(canonical);
    }
  });

  it('property test: normalizeSkill is strictly idempotent f(f(x)) === f(x) for all aliases', () => {
    const entries = Object.keys(skillAliases);
    expect(entries.length).toBeGreaterThanOrEqual(100);

    for (const key of entries) {
      const canonical = normalizeSkill(key);
      const secondPass = normalizeSkill(canonical);
      const thirdPass = normalizeSkill(secondPass);

      expect(secondPass).toBe(canonical);
      expect(thirdPass).toBe(secondPass);
    }
  });

  it('property test: normalizeSkill is idempotent for arbitrary unknown skills', () => {
    const arbitrarySkills = [
      'MyCustomTool',
      'Advanced GraphQL Federation v2',
      'Distributed Systems 101',
      '  Leading  Edge   AI  ',
    ];

    for (const skill of arbitrarySkills) {
      const first = normalizeSkill(skill);
      const second = normalizeSkill(first);
      expect(second).toBe(first);
    }
  });
});
