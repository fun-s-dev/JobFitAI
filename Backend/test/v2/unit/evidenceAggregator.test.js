import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  projectEvidenceScore,
  aggregateProjectEvidence,
} = require('../../../src/v2/core/evidenceAggregator');

describe('core/evidenceAggregator (pure)', () => {
  it('returns null when claimSkills is empty or null', () => {
    expect(projectEvidenceScore([], [{ skill: 'Express', strength: 0.5 }])).toBeNull();
    expect(projectEvidenceScore(null, [{ skill: 'Express', strength: 0.5 }])).toBeNull();
    const agg = aggregateProjectEvidence([], [{ skill: 'Express', strength: 0.5 }]);
    expect(agg.score).toBeNull();
    expect(agg.evidenceItemIds).toEqual([]);
    expect(agg.contradictions).toEqual([]);
  });

  it('returns null when no relevant evidence items match the claim skills (null propagates)', () => {
    const items = [
      { skill: 'Python', type: 'source_file', strength: 0.8 },
      { skill: 'Django', type: 'dependency', strength: 0.5 },
    ];
    expect(projectEvidenceScore(['Express', 'React'], items)).toBeNull();
  });

  it('proves README + manifest + resume do NOT triple-count (max + tiny bonus, never a sum)', () => {
    // A candidate writes "Express" on resume, README, and has package.json dependency
    const items = [
      { _id: '1', skill: 'Express', type: 'readme', strength: 0.5, contradiction: false },
      { _id: '2', skill: 'Express', type: 'dependency', strength: 0.5, contradiction: false },
    ];

    const score = projectEvidenceScore(['Express'], items);
    // best = 0.5, distinctTypes = 2 ('readme', 'dependency') -> 0.5 + 0.05 * (2 - 1) = 0.55
    expect(score).toBe(0.55);
    expect(score).toBeLessThan(0.60); // Not 1.0 or sum
  });

  it('computes best strength plus 0.05 per extra distinct artifact type capped at 1.0', () => {
    const items = [
      { _id: '1', skill: 'REST APIs', type: 'dependency', strength: 0.3, contradiction: false },
      { _id: '2', skill: 'REST APIs', type: 'source_file', strength: 0.8, contradiction: false },
      { _id: '3', skill: 'REST APIs', type: 'test', strength: 0.9, contradiction: false },
    ];

    // best = 0.9, 3 distinct types -> 0.9 + 0.05 * (3 - 1) = 1.0
    const score = projectEvidenceScore(['REST APIs'], items);
    expect(score).toBe(1.0);
  });

  it('excludes contradictions from score calculation and surfaces them', () => {
    const items = [
      {
        _id: '1',
        skill: 'Redis',
        type: 'readme',
        strength: 0.0,
        contradiction: true,
        claimSupport: 'Mentioned in README but not found in manifest or AST',
      },
    ];

    // Since only contradiction exists, score must be null (contradiction never raises score)
    const score = projectEvidenceScore(['Redis'], items);
    expect(score).toBeNull();

    const agg = aggregateProjectEvidence(['Redis'], items);
    expect(agg.score).toBeNull();
    expect(agg.contradictions.length).toBe(1);
    expect(agg.contradictions[0]).toContain('Mentioned in README but not found in manifest or AST');
  });

  it('preserves valid corroboration while surfacing contradictions for compound claims', () => {
    const items = [
      {
        _id: '1',
        skill: 'Express',
        type: 'source_file',
        strength: 0.8,
        contradiction: false,
      },
      {
        _id: '2',
        skill: 'Redis',
        type: 'readme',
        strength: 0.0,
        contradiction: true,
        claimSupport: 'Redis mentioned in README but missing in code',
      },
    ];

    const agg = aggregateProjectEvidence(['Express', 'Redis'], items);
    expect(agg.score).toBe(0.8);
    expect(agg.contradictions).toEqual(['Redis mentioned in README but missing in code']);
  });
});
