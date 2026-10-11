import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  checkBulletCoverage,
  extractNumericTokens,
  extractTechTokens,
  normalizeNumericToken,
} = require('../../../src/v2/core/coverageCheck');

describe('core/coverageCheck', () => {
  describe('extractNumericTokens & normalizeNumericToken', () => {
    it('extracts and normalizes numbers with percentages, multipliers, suffixes, and metrics', () => {
      const text = 'Improved p95 latency by 40% across 1,000 services, saving $2M and 10k hours (3x speedup, 99.9% uptime).';
      const tokens = extractNumericTokens(text);

      expect(tokens).toContain('p95');
      expect(tokens).toContain('40%');
      expect(tokens).toContain('1,000');
      expect(tokens).toContain('$2M');
      expect(tokens).toContain('10k');
      expect(tokens).toContain('3x');
      expect(tokens).toContain('99.9%');

      // Normalization equalities
      expect(normalizeNumericToken('40 %')).toBe(normalizeNumericToken('40%'));
      expect(normalizeNumericToken('1,000')).toBe(normalizeNumericToken('1000'));
      expect(normalizeNumericToken('$2M')).toBe(normalizeNumericToken('2m'));
      expect(normalizeNumericToken('10K')).toBe(normalizeNumericToken('10k'));
    });

    it('matches trailing percentage without word-boundary failure', () => {
      const text = 'Reduced CPU usage by 40%';
      const tokens = extractNumericTokens(text);
      expect(tokens).toContain('40%');
    });
  });

  describe('extractTechTokens', () => {
    it('skips sentence-starting verbs and does not treat them as tech terms', () => {
      const text = 'Built scalable microservices and Developed internal tools.';
      const tokens = extractTechTokens(text);
      expect(tokens).not.toContain('Built');
      expect(tokens).not.toContain('Developed');
    });

    it('detects known skills, CamelCase, dotted names, and ALL-CAPS acronyms', () => {
      const text = 'Engineered a GraphQL service using Node.js, Express, and Redis with AWS CI/CD pipelines.';
      const tokens = extractTechTokens(text);

      expect(tokens).toContain('GraphQL'); // CamelCase
      expect(tokens).toContain('Node.js'); // Dotted tech
      expect(tokens).toContain('Express'); // Known skill
      expect(tokens).toContain('Redis');   // Known skill
      expect(tokens).toContain('AWS');     // ALL-CAPS acronym
      expect(tokens).toContain('CI/CD');   // Acronym
    });

    it('matches ambiguous short names only in exact capitalization', () => {
      const textWithTech = 'Implemented backend in Go and C with Spring Boot.';
      const tokens1 = extractTechTokens(textWithTech);
      expect(tokens1).toContain('Go');
      expect(tokens1).toContain('C');
      expect(tokens1).toContain('Spring Boot');

      const textWithEnglish = 'Ready to go to the store and spring into action with a c class car.';
      const tokens2 = extractTechTokens(textWithEnglish);
      expect(tokens2).not.toContain('go');
      expect(tokens2).not.toContain('spring');
      expect(tokens2).not.toContain('c');
    });
  });

  describe('checkBulletCoverage', () => {
    it('passes when all numbers and tech tokens are covered in claims', () => {
      const bullet = 'Architected an event-driven notification service using RabbitMQ and Node.js, slashing message delivery time by 35% across 2M daily notifications.';
      const claims = [
        {
          bulletId: 'exp0.b0',
          claimText: 'Candidate architected an event-driven notification service',
          claimType: 'leadership',
          skills: [],
          numbers: [],
        },
        {
          bulletId: 'exp0.b0',
          claimText: 'Candidate used RabbitMQ and Node.js',
          claimType: 'technology',
          skills: ['RabbitMQ', 'Node.js'],
          numbers: [],
        },
        {
          bulletId: 'exp0.b0',
          claimText: 'Message delivery time was slashed by 35%',
          claimType: 'metric',
          skills: [],
          numbers: ['35%'],
        },
        {
          bulletId: 'exp0.b0',
          claimText: 'The service processed 2M daily notifications',
          claimType: 'metric',
          skills: [],
          numbers: ['2M'],
        },
      ];

      const result = checkBulletCoverage(bullet, claims);
      expect(result.ok).toBe(true);
      expect(result.missingNumbers).toEqual([]);
      expect(result.missingTech).toEqual([]);
    });

    it('rejects when a numeric token is dropped by claims', () => {
      const bullet = 'Scaled backend throughput by 40% across 1,000 servers.';
      // Missing '1,000'
      const claims = [
        {
          bulletId: 'exp0.b0',
          claimText: 'Scaled backend throughput by 40%',
          claimType: 'metric',
          skills: [],
          numbers: ['40%'],
        },
      ];

      const result = checkBulletCoverage(bullet, claims);
      expect(result.ok).toBe(false);
      expect(result.missingNumbers).toEqual(['1,000']);
    });

    it('rejects when a prominent technology token is completely omitted from claims', () => {
      const bullet = 'Migrated relational database to PostgreSQL and Redis caching.';
      // PostgreSQL omitted
      const claims = [
        {
          bulletId: 'exp0.b0',
          claimText: 'Migrated relational database to cache layer',
          claimType: 'responsibility',
          skills: ['Redis'],
          numbers: [],
        },
      ];

      const result = checkBulletCoverage(bullet, claims);
      expect(result.ok).toBe(false);
      expect(result.missingTech).toContain('PostgreSQL');
    });

    it('handles normalized number equality (40 % matches 40%, 1,000 matches 1000)', () => {
      const bullet = 'Cut latency by 40% across 1,000 endpoints.';
      const claims = [
        {
          bulletId: 'exp0.b0',
          claimText: 'Cut latency by 40 % across 1000 endpoints',
          claimType: 'metric',
          skills: [],
          numbers: ['40 %', '1000'],
        },
      ];

      const result = checkBulletCoverage(bullet, claims);
      expect(result.ok).toBe(true);
    });

    it('asserts all 20 fixture golden extractions produce zero false failures', () => {
      const fixtures = require('../../../test/fixtures/bulletClaims.fixture.json');
      expect(fixtures.length).toBe(20);

      for (const item of fixtures) {
        const result = checkBulletCoverage(item.bulletText, item.goldenClaims);
        expect(result.ok, `Failed coverage for bullet: "${item.bulletText}". Missing numbers: ${result.missingNumbers}, Missing tech: ${result.missingTech}`).toBe(true);
        expect(result.missingNumbers).toEqual([]);
        expect(result.missingTech).toEqual([]);
      }
    });
  });
});

