import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { containsTerm, buildRepoChunks, scoreRepo, matchLevel, rankRepos, MAX_CHUNKS_PER_REPO } = require('../../../src/v2/core/repoRanking');

describe('core/repoRanking (pure)', () => {
  describe('containsTerm', () => {
    it('matches whole terms, ignoring case and punctuation around them', () => {
      expect(containsTerm('Built with Node.js and MongoDB.', 'node.js')).toBe(true);
      expect(containsTerm('Built with Node.js and MongoDB.', 'MongoDB')).toBe(true);
      expect(containsTerm('uses c++ daily', 'c++')).toBe(true);
      expect(containsTerm('stack: react, redux', 'React')).toBe(true);
    });

    it('does not match a term inside a longer word', () => {
      expect(containsTerm('A MongoDB app', 'go')).toBe(false);
      expect(containsTerm('JavaScript only', 'java')).toBe(false);
      expect(containsTerm('reactor core', 'react')).toBe(false);
    });

    it('is safe for empty input and regex metacharacters', () => {
      expect(containsTerm('anything', '')).toBe(false);
      expect(containsTerm('', 'node')).toBe(false);
      expect(containsTerm('a (b) c', '(b)')).toBe(true);
      expect(() => containsTerm('x', '[')).not.toThrow();
    });
  });

  describe('buildRepoChunks', () => {
    const analysis = {
      repositoryFullName: 'alice/node-api',
      description: 'A REST API',
      languages: { JavaScript: 900, Dockerfile: 10 },
      dependencies: [{ name: 'express' }, { name: 'mongoose' }, { name: 'express' }],
      readmeText: '# Node API\n\nA REST API built with Express and MongoDB.\n\n## Features\n- JWT login\n- Rate limiting',
    };

    it('creates description, stack and README chunks with unique ids, in that order', () => {
      const { chunks, repoText } = buildRepoChunks(analysis);
      expect(chunks[0]).toMatchObject({ source: 'metadata', text: 'A REST API' });
      expect(chunks[1]).toMatchObject({ source: 'dependencies' });
      expect(chunks[1].text).toBe('Technologies used: JavaScript, Dockerfile, express, mongoose'); // de-duplicated
      expect(chunks.slice(2).every((c) => c.source === 'readme')).toBe(true);
      expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
      expect(chunks.every((c) => c.embedText.includes('node-api'))).toBe(true);
      expect(repoText).toMatch(/express/);
      expect(repoText).toMatch(/JWT login/);
    });

    it('caps the number of chunks and drops the README tail first', () => {
      const long = { ...analysis, readmeText: Array.from({ length: 200 }, (_, i) => `Paragraph number ${i} about the project.`).join('\n\n') };
      const { chunks } = buildRepoChunks(long);
      expect(chunks.length).toBeLessThanOrEqual(MAX_CHUNKS_PER_REPO);
      expect(chunks[0].source).toBe('metadata');
      expect(buildRepoChunks(long, { maxChunks: 3 }).chunks).toHaveLength(3);
    });

    it('copes with a repository that has no README, description or dependencies', () => {
      const { chunks, repoText } = buildRepoChunks({ repositoryFullName: 'a/b' });
      expect(chunks).toEqual([]);
      expect(repoText).toBe('');
    });
  });

  describe('scoreRepo', () => {
    // Axis-aligned unit vectors: requirement i is "about" dimension i
    const reqs = [
      { text: 'REST APIs with Node.js', importance: 'must', keywords: ['Node.js'] },
      { text: 'RAG pipelines', importance: 'nice', keywords: ['RAG'] },
    ];
    const reqVecs = [[1, 0, 0], [0, 1, 0]];
    const chunk = (id, text, source = 'readme') => ({ id, text, source, embedText: text });

    it('scores a repository that covers a must requirement higher than one covering only a nice-to-have', () => {
      const nodeRepo = scoreRepo({
        requirements: reqs,
        requirementVectors: reqVecs,
        chunkItems: [{ chunk: chunk('c1', 'REST API in Node.js'), vector: [1, 0, 0] }],
        repoText: 'REST API in Node.js',
      });
      const ragRepo = scoreRepo({
        requirements: reqs,
        requirementVectors: reqVecs,
        chunkItems: [{ chunk: chunk('c2', 'A RAG assistant'), vector: [0, 1, 0] }],
        repoText: 'A RAG assistant',
      });
      expect(nodeRepo.score).toBeGreaterThan(ragRepo.score);
      expect(nodeRepo.semanticScore).toBeCloseTo(1 / 1.5, 3); // must weight 1, nice weight 0.5
      expect(ragRepo.semanticScore).toBeCloseTo(0.5 / 1.5, 3);
    });

    it('returns the best matching snippet per requirement as the reason, and counts the unmatched ones', () => {
      const r = scoreRepo({
        requirements: reqs,
        requirementVectors: reqVecs,
        chunkItems: [
          { chunk: chunk('c1', 'REST API in Node.js'), vector: [1, 0, 0] },
          { chunk: chunk('c2', 'unrelated'), vector: [0, 0, 1] },
        ],
        repoText: 'REST API in Node.js',
      });
      expect(r.matched).toHaveLength(1);
      expect(r.matched[0]).toMatchObject({ requirement: 'REST APIs with Node.js', importance: 'must', snippet: 'REST API in Node.js', source: 'readme' });
      expect(r.matched[0].cosine).toBe(1);
      expect(r.unmatchedRequirements).toBe(1);
    });

    it('mixes in keyword presence (70% semantic, 30% keyword) and reports it separately', () => {
      const withKeyword = scoreRepo({
        requirements: [reqs[0]],
        requirementVectors: [reqVecs[0]],
        chunkItems: [{ chunk: chunk('c1', 'x'), vector: [0, 0, 1] }], // no semantic match at all
        repoText: 'this repo is written in node.js',
      });
      expect(withKeyword.semanticScore).toBe(0);
      expect(withKeyword.keywordScore).toBe(1);
      expect(withKeyword.score).toBeCloseTo(0.3, 4);

      const without = scoreRepo({
        requirements: [reqs[0]],
        requirementVectors: [reqVecs[0]],
        chunkItems: [{ chunk: chunk('c1', 'x'), vector: [0, 0, 1] }],
        repoText: 'written in python',
      });
      expect(without.keywordScore).toBe(0);
      expect(without.score).toBe(0);
    });

    it('uses the semantic score alone when no requirement has keywords', () => {
      const r = scoreRepo({
        requirements: [{ text: 'Team player', importance: 'must', keywords: [] }],
        requirementVectors: [[1, 0, 0]],
        chunkItems: [{ chunk: chunk('c1', 'we collaborate'), vector: [1, 0, 0] }],
        repoText: 'we collaborate',
      });
      expect(r.keywordScore).toBeNull();
      expect(r.score).toBe(1);
    });

    it('handles a repository with no chunks and empty requirements without throwing', () => {
      expect(scoreRepo({ requirements: reqs, requirementVectors: reqVecs, chunkItems: [], repoText: '' }).score).toBe(0);
      expect(scoreRepo({ requirements: [], requirementVectors: [], chunkItems: [], repoText: '' }).score).toBe(0);
    });
  });

  describe('calibration on real embeddings (saved vectors)', () => {
    // Real gemini-embedding-001 vectors for five repositories vs five job requirements, saved from a live
    // calibration run. Guards the scale: unrelated repositories must not outrank or tie relevant ones.
    const fixture = require('../../fixtures/ranking-calibration.json');

    it('orders strong > partial > unrelated and gives unrelated repositories no reasons', () => {
      const { requirements, vectors, repos } = fixture;
      const reqVecs = vectors.slice(0, requirements.length);
      const scored = repos.map((r) => {
        const items = r.passages.map((text, i) => ({ chunk: { id: `c${i}`, text, source: 'readme' }, vector: vectors[r.offset + i] }));
        const res = scoreRepo({ requirements, requirementVectors: reqVecs, chunkItems: items, repoText: r.passages.join('\n') });
        return { name: r.name, kind: r.kind, ...res, level: matchLevel(res.score) };
      });
      const byKind = (k) => scored.filter((s) => s.kind === k);
      const minStrong = Math.min(...byKind('strong').map((s) => s.score));
      const maxPartial = Math.max(...byKind('partial').map((s) => s.score));
      const maxUnrelated = Math.max(...byKind('unrelated').map((s) => s.score));

      expect(minStrong).toBeGreaterThan(maxPartial);
      expect(maxPartial).toBeGreaterThan(maxUnrelated);
      expect(byKind('strong').every((s) => s.level === 'strong')).toBe(true);
      expect(byKind('unrelated').every((s) => s.level === 'weak')).toBe(true);
      expect(byKind('unrelated').every((s) => s.matched.length === 0)).toBe(true);
    });
  });

  describe('matchLevel', () => {
    it('bands the score', () => {
      expect(matchLevel(0.61)).toBe('strong');
      expect(matchLevel(0.35)).toBe('strong');
      expect(matchLevel(0.2)).toBe('partial');
      expect(matchLevel(0.17)).toBe('weak');
      expect(matchLevel(0)).toBe('weak');
    });
  });

  describe('rankRepos', () => {
    it('orders by score, then most recent push, then name, and numbers ranks from 1', () => {
      const input = [
        { fullName: 'a/old', score: 0.5, pushedAt: '2024-01-01' },
        { fullName: 'a/best', score: 0.9, pushedAt: '2023-01-01' },
        { fullName: 'a/new', score: 0.5, pushedAt: '2025-01-01' },
        { fullName: 'a/aaa', score: 0.2 },
      ];
      const out = rankRepos(input);
      expect(out.map((r) => r.fullName)).toEqual(['a/best', 'a/new', 'a/old', 'a/aaa']);
      expect(out.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
      expect(input[0].rank).toBeUndefined(); // input not mutated
    });

    it('returns an empty list for empty input', () => {
      expect(rankRepos([])).toEqual([]);
      expect(rankRepos(undefined)).toEqual([]);
    });
  });
});
