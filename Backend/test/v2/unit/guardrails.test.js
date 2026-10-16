import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateGuardrails } = require('../../../src/v2/core/guardrails');

describe('core/guardrails (pure)', () => {
  describe('Number rule', () => {
    const testCases = [
      {
        name: 'matches identical number in claim and evidence',
        claim: { claimText: 'Reduced latency by 40%', numbers: ['40%'] },
        chunks: [{ text: 'Optimized queries and reduced latency by 40% in production.' }],
        expectedCaps: [],
      },
      {
        name: 'matches whitespace variations (40 % vs 40%)',
        claim: { claimText: 'Reduced latency by 40 %', numbers: ['40 %'] },
        chunks: [{ text: 'Latency dropped 40% across endpoints.' }],
        expectedCaps: [],
      },
      {
        name: 'matches thousand separators (1,000 vs 1000)',
        claim: { claimText: 'Handled 1,000 requests per second', numbers: ['1,000'] },
        chunks: [{ text: 'Scaled backend to process 1000 requests per second.' }],
        expectedCaps: [],
      },
      {
        name: 'matches percentile metrics (p95)',
        claim: { claimText: 'Improved p95 response time', numbers: ['p95'] },
        chunks: [{ text: 'Monitored p95 latency using Prometheus.' }],
        expectedCaps: [],
      },
      {
        name: 'matches multipliers (3x)',
        claim: { claimText: 'Increased throughput 3x', numbers: ['3x'] },
        chunks: [{ text: 'Redesigned architecture for 3x performance increase.' }],
        expectedCaps: [],
      },
      {
        name: 'matches currency suffixes ($2M)',
        claim: { claimText: 'Handled budget of $2M', numbers: ['$2M'] },
        chunks: [{ text: 'Oversaw operational budget of 2m dollars.' }],
        expectedCaps: [],
      },
      {
        name: 'caps needs_review when claim number is missing from evidence',
        claim: { claimText: 'Cut latency by 45%', numbers: ['45%'] },
        chunks: [{ text: 'Reduced latency by 15% via indexing.' }],
        expectedCaps: ['needs_review'],
      },
      {
        name: 'caps needs_review when one of multiple numbers is missing',
        claim: { claimText: 'Led 5 teams and cut latency 30%', numbers: ['5', '30%'] },
        chunks: [{ text: 'Managed 5 teams across offices.' }], // 30% is missing
        expectedCaps: ['needs_review'],
      },
      {
        name: 'passes with no caps when claim has no numbers',
        claim: { claimText: 'Built REST APIs using Express', numbers: [] },
        chunks: [{ text: 'Built backend APIs with Express.' }],
        expectedCaps: [],
      },
    ];

    testCases.forEach(({ name, claim, chunks, expectedCaps }) => {
      it(name, () => {
        const result = evaluateGuardrails({ claim, chunks });
        if (expectedCaps.includes('needs_review')) {
          expect(result.caps).toContain('needs_review');
        } else {
          expect(result.caps).toEqual([]);
        }
      });
    });
  });

  describe('Leadership rule', () => {
    it('passes without cap when claim has leadership verb and evidence contains active leadership cue', () => {
      const claim = { claimText: 'Led a team of 6 software engineers', numbers: ['6'] };
      const chunks = [{ text: 'Led a cross-functional squad of 6 engineers to deliver platform features.' }];
      const result = evaluateGuardrails({ claim, chunks });
      expect(result.caps).toEqual([]);
    });

    it('caps needs_review when claim has leadership verb but evidence has no leadership cues', () => {
      const claim = { claimText: 'Architected distributed caching system with Redis', numbers: [] };
      const chunks = [{ text: 'Used Redis for caching session objects in Express.' }];
      const result = evaluateGuardrails({ claim, chunks });
      expect(result.caps).toContain('needs_review');
    });

    it('known weakness: passive "worked with the team lead" does NOT satisfy leadership cue', () => {
      const claim = { claimText: 'Managed project delivery timelines', numbers: [] };
      const chunks = [{ text: 'Collaborated and worked with the team lead on project milestones.' }];
      const result = evaluateGuardrails({ claim, chunks });
      expect(result.caps).toContain('needs_review');
    });

    it('known weakness: "assisted senior engineers" does NOT satisfy leadership cue', () => {
      const claim = { claimText: 'Directed migration of legacy infrastructure', numbers: [] };
      const chunks = [{ text: 'Assisted senior engineers during database migration.' }];
      const result = evaluateGuardrails({ claim, chunks });
      expect(result.caps).toContain('needs_review');
    });

    it('does not cap when claim has no leadership verbs', () => {
      const claim = { claimText: 'Implemented JWT token verification middleware', numbers: [] };
      const chunks = [{ text: 'Wrote authentication handlers with jsonwebtoken.' }];
      const result = evaluateGuardrails({ claim, chunks });
      expect(result.caps).toEqual([]);
    });
  });
});
