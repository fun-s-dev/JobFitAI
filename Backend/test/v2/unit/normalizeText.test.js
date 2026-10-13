import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeText } = require('../../../src/v2/core/normalizeText');

describe('core/normalizeText (pure)', () => {
  it('applies Unicode NFKC normalization', () => {
    // \uFB01 is 'fi' ligature -> should normalize to 'fi'
    const input = 'Super\uFB01cial \u2122';
    const output = normalizeText(input);
    expect(output).toContain('Superficial');
    expect(output).toContain('TM');
  });

  it('replaces bullet glyphs only at the start of a line with "-"', () => {
    const input = `• First item\n  ▪ Second item\n● Third item\n◆ Fourth item`;
    const output = normalizeText(input);
    expect(output).toBe(`- First item\n- Second item\n- Third item\n- Fourth item`);
  });

  it('does NOT replace en or em dashes in date ranges or mid-line titles', () => {
    const input = `Software Engineer (2022 – 2024)\nAcme Corp — Full Time`;
    const output = normalizeText(input);
    expect(output).toContain('2022 – 2024');
    expect(output).toContain('Acme Corp — Full Time');
  });

  it('re-joins words hyphenated across line breaks', () => {
    const input = `Architected a micro-\nservices backend with dis-\r\ntributed caching.`;
    const output = normalizeText(input);
    expect(output).toContain('microservices');
    expect(output).toContain('distributed');
  });

  it('collapses excessive horizontal and vertical whitespace typical of pdf-parse', () => {
    const input = `
    
      Jane Doe      
    
      jane@example.com      
      
      Experience:
      • Built     APIs   with   Node.js.   
      
      
      
      • Deployed on AWS.    
    `;
    const output = normalizeText(input);
    expect(output).not.toMatch(/[ ]{2,}/);
    expect(output).not.toMatch(/\n{3,}/);
    expect(output).toContain('- Built APIs with Node.js.');
    expect(output).toContain('- Deployed on AWS.');
  });

  it('handles empty or non-string inputs gracefully', () => {
    expect(normalizeText('')).toBe('');
    expect(normalizeText(null)).toBe('');
    expect(normalizeText(undefined)).toBe('');
  });
});
