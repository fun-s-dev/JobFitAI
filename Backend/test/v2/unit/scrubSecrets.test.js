import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scrubSecrets } = require('../../../src/v2/core/scrubSecrets');

describe('core/scrubSecrets (pure)', () => {
  it('removes AWS access key IDs (AKIA...)', () => {
    const raw = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nother content';
    const scrubbed = scrubSecrets(raw);
    expect(scrubbed).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(scrubbed).toContain('[SCRUBBED_AWS_KEY]');
  });

  it('removes GitHub personal access tokens (ghp_...) and other GitHub tokens', () => {
    const raw = 'const token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";\nconst oauth = "gho_abcdefghijklmnopqrstuvwxyz1234567890";';
    const scrubbed = scrubSecrets(raw);
    expect(scrubbed).not.toContain('ghp_1234567890abcdefghijklmnopqrstuvwxyz');
    expect(scrubbed).not.toContain('gho_abcdefghijklmnopqrstuvwxyz1234567890');
    expect(scrubbed).toContain('[SCRUBBED_GITHUB_TOKEN]');
  });

  it('removes RSA and generic private key blocks', () => {
    const raw = `
Some text before
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0m3...
secret base64 key material here
-----END RSA PRIVATE KEY-----
Some text after
-----BEGIN EC PRIVATE KEY-----
MHcCAQEE...
-----END EC PRIVATE KEY-----
`;
    const scrubbed = scrubSecrets(raw);
    expect(scrubbed).not.toContain('MIIEowIBAAKCAQEA0m3...');
    expect(scrubbed).not.toContain('MHcCAQEE...');
    expect(scrubbed).toContain('[SCRUBBED_PRIVATE_KEY]');
    expect(scrubbed).toContain('Some text before');
    expect(scrubbed).toContain('Some text after');
  });

  it('preserves clean text without false positives', () => {
    const clean = 'function add(a, b) { return a + b; }\nconsole.log("hello world");';
    expect(scrubSecrets(clean)).toBe(clean);
  });

  it('handles non-string or empty input safely', () => {
    expect(scrubSecrets('')).toBe('');
    expect(scrubSecrets(null)).toBe('');
    expect(scrubSecrets(undefined)).toBe('');
  });
});
