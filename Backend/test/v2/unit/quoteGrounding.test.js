import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { groundQuote } = require('../../../src/v2/core/quoteGrounding');

describe('core/quoteGrounding (pure)', () => {
  const sampleChunks = [
    {
      id: 'chunk_1',
      text: 'Architected distributed backend services in Node.js and Express handling 50k requests per second.',
      context: 'Irrelevant context text that should never be searched',
    },
    {
      id: 'chunk_2',
      text: 'Migrated monolithic database from MySQL to PostgreSQL, cutting p95 query latency by 40%.',
      context: 'Another context field',
    },
  ];

  it('passes on exact substring match and returns chunk id and char offsets', () => {
    const result = groundQuote({
      quote: 'Node.js and Express handling 50k requests',
      chunks: sampleChunks,
      verdict: 'yes',
    });

    expect(result.isGrounded).toBe(true);
    expect(result.quoteUngrounded).toBe(false);
    expect(result.finalVerdict).toBe('yes');
    expect(result.groundedChunkId).toBe('chunk_1');
    expect(typeof result.charStart).toBe('number');
    expect(typeof result.charEnd).toBe('number');
    // Verify offsets correspond to the exact substring
    const matchedSubstring = sampleChunks[0].text.slice(result.charStart, result.charEnd);
    expect(matchedSubstring).toBe('Node.js and Express handling 50k requests');
  });

  it('passes on minor casing, punctuation, and whitespace variations (ratio >= 0.90)', () => {
    // Original: "cutting p95 query latency by 40%."
    // Quote with altered casing and punctuation
    const result = groundQuote({
      quote: 'Cutting P95 Query Latency by 40%',
      chunks: sampleChunks,
      verdict: 'yes',
    });

    expect(result.isGrounded).toBe(true);
    expect(result.quoteUngrounded).toBe(false);
    expect(result.finalVerdict).toBe('yes');
    expect(result.groundedChunkId).toBe('chunk_2');
    expect(result.charStart).toBeGreaterThanOrEqual(0);
    expect(result.charEnd).toBeGreaterThan(result.charStart);
  });

  it('FAILS when quote is assembled from words scattered across evidence (must not pass)', () => {
    // "Architected", "monolithic", "PostgreSQL", "Express" appear in the text, but not in contiguous sequence
    const result = groundQuote({
      quote: 'Architected monolithic PostgreSQL Express services',
      chunks: sampleChunks,
      verdict: 'yes',
    });

    expect(result.isGrounded).toBe(false);
    expect(result.quoteUngrounded).toBe(true);
    expect(result.finalVerdict).toBe('no');
    expect(result.groundedChunkId).toBeNull();
  });

  it('FAILS on completely fabricated quote and downgrades verdict to no', () => {
    const result = groundQuote({
      quote: 'Managed a team of twenty engineers in Kubernetes orchestration',
      chunks: sampleChunks,
      verdict: 'partial',
    });

    expect(result.isGrounded).toBe(false);
    expect(result.quoteUngrounded).toBe(true);
    expect(result.finalVerdict).toBe('no');
    expect(result.groundedChunkId).toBeNull();
  });

  it('FAILS when quote has fewer than 3 tokens for a yes or partial verdict', () => {
    const result = groundQuote({
      quote: 'Express handling', // only 2 tokens
      chunks: sampleChunks,
      verdict: 'yes',
    });

    expect(result.isGrounded).toBe(false);
    expect(result.quoteUngrounded).toBe(true);
    expect(result.finalVerdict).toBe('no');
  });

  it('FAILS when quote exceeds 25 words (maximum allowed length)', () => {
    const longQuote =
      'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo twentythree twentyfour twentyfive twentysix';
    const result = groundQuote({
      quote: longQuote,
      chunks: sampleChunks,
      verdict: 'yes',
    });

    expect(result.isGrounded).toBe(false);
    expect(result.quoteUngrounded).toBe(true);
    expect(result.finalVerdict).toBe('no');
  });

  it('FAILS when quote is empty for a yes or partial verdict', () => {
    const result = groundQuote({
      quote: '',
      chunks: sampleChunks,
      verdict: 'yes',
    });

    expect(result.isGrounded).toBe(false);
    expect(result.quoteUngrounded).toBe(true);
    expect(result.finalVerdict).toBe('no');
  });

  it('allows empty quote when verdict is already no (quoteUngrounded remains false)', () => {
    const result = groundQuote({
      quote: '',
      chunks: sampleChunks,
      verdict: 'no',
    });

    expect(result.isGrounded).toBe(true);
    expect(result.quoteUngrounded).toBe(false);
    expect(result.finalVerdict).toBe('no');
    expect(result.groundedChunkId).toBeNull();
  });

  it('grounds strictly against chunk text, never against context or metadata', () => {
    const result = groundQuote({
      quote: 'Irrelevant context text that should never be searched',
      chunks: sampleChunks,
      verdict: 'yes',
    });

    // Even though the phrase appears in chunk.context, it is NOT in chunk.text
    expect(result.isGrounded).toBe(false);
    expect(result.quoteUngrounded).toBe(true);
    expect(result.finalVerdict).toBe('no');
  });
});
