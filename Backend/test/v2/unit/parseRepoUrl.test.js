import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseRepoUrl, InvalidRepoUrlError } = require('../../../src/v2/core/parseRepoUrl');

describe('core/parseRepoUrl (pure)', () => {
  it('accepts a clean standard https GitHub repository URL', () => {
    const res = parseRepoUrl('https://github.com/facebook/react');
    expect(res).toEqual({
      owner: 'facebook',
      repo: 'react',
      repositoryFullName: 'facebook/react',
    });
  });

  it('accepts URLs ending with .git', () => {
    const res = parseRepoUrl('https://github.com/expressjs/express.git');
    expect(res).toEqual({
      owner: 'expressjs',
      repo: 'express',
      repositoryFullName: 'expressjs/express',
    });
  });

  it('accepts URLs with trailing slashes', () => {
    const res1 = parseRepoUrl('https://github.com/nodejs/node/');
    expect(res1).toEqual({
      owner: 'nodejs',
      repo: 'node',
      repositoryFullName: 'nodejs/node',
    });

    const res2 = parseRepoUrl('https://github.com/nodejs/node.git/');
    expect(res2).toEqual({
      owner: 'nodejs',
      repo: 'node',
      repositoryFullName: 'nodejs/node',
    });
  });

  it('accepts valid owner and repo names with dots, underscores, and hyphens', () => {
    const res = parseRepoUrl('https://github.com/test-org_1.0/my_repo-name.v2');
    expect(res).toEqual({
      owner: 'test-org_1.0',
      repo: 'my_repo-name.v2',
      repositoryFullName: 'test-org_1.0/my_repo-name.v2',
    });
  });

  it('rejects HTTP URLs (HTTPS only)', () => {
    expect(() => parseRepoUrl('http://github.com/owner/repo')).toThrow(InvalidRepoUrlError);
  });

  it('rejects localhost and private IP addresses', () => {
    expect(() => parseRepoUrl('http://localhost/owner/repo')).toThrow(InvalidRepoUrlError);
    expect(() => parseRepoUrl('https://localhost/owner/repo')).toThrow(InvalidRepoUrlError);
    expect(() => parseRepoUrl('https://127.0.0.1/owner/repo')).toThrow(InvalidRepoUrlError);
    expect(() => parseRepoUrl('https://192.168.1.1/owner/repo')).toThrow(InvalidRepoUrlError);
    expect(() => parseRepoUrl('https://[::1]/owner/repo')).toThrow(InvalidRepoUrlError);
  });

  it('rejects domain spoofing / suffix attacks (github.com.evil.com)', () => {
    expect(() => parseRepoUrl('https://github.com.evil.com/owner/repo')).toThrow(InvalidRepoUrlError);
    expect(() => parseRepoUrl('https://evil-github.com/owner/repo')).toThrow(InvalidRepoUrlError);
    expect(() => parseRepoUrl('https://notgithub.com/owner/repo')).toThrow(InvalidRepoUrlError);
    expect(() => parseRepoUrl('https://api.github.com/owner/repo')).toThrow(InvalidRepoUrlError);
  });

  it('rejects userinfo tricks (user:pass@github.com)', () => {
    expect(() => parseRepoUrl('https://evil:token@github.com/owner/repo')).toThrow(InvalidRepoUrlError);
    expect(() => parseRepoUrl('https://user@github.com/owner/repo')).toThrow(InvalidRepoUrlError);
  });

  it('rejects path traversal (../) in raw string and parsed URL', () => {
    expect(() => parseRepoUrl('https://github.com/owner/../evil/repo')).toThrow(InvalidRepoUrlError);
    expect(() => parseRepoUrl('https://github.com/../../etc/passwd')).toThrow(InvalidRepoUrlError);
    expect(() => parseRepoUrl('https://github.com/owner/..')).toThrow(InvalidRepoUrlError);
  });

  it('rejects extra path segments beyond owner and repo', () => {
    expect(() => parseRepoUrl('https://github.com/owner/repo/tree/main')).toThrow(InvalidRepoUrlError);
    expect(() => parseRepoUrl('https://github.com/owner/repo/blob/master/README.md')).toThrow(InvalidRepoUrlError);
    expect(() => parseRepoUrl('https://github.com/owner/repo/pull/123')).toThrow(InvalidRepoUrlError);
  });

  it('rejects missing repo or missing owner', () => {
    expect(() => parseRepoUrl('https://github.com/owner')).toThrow(InvalidRepoUrlError);
    expect(() => parseRepoUrl('https://github.com/')).toThrow(InvalidRepoUrlError);
    expect(() => parseRepoUrl('https://github.com')).toThrow(InvalidRepoUrlError);
  });

  it('rejects special or dangerous characters in owner and repo', () => {
    expect(() => parseRepoUrl('https://github.com/own$er/repo')).toThrow(InvalidRepoUrlError);
    expect(() => parseRepoUrl('https://github.com/owner/re%20po')).toThrow(InvalidRepoUrlError);
    expect(() => parseRepoUrl('https://github.com/owner/<script>')).toThrow(InvalidRepoUrlError);
    expect(() => parseRepoUrl('https://github.com/owner/.git')).toThrow(InvalidRepoUrlError);
    expect(() => parseRepoUrl('https://github.com/./repo')).toThrow(InvalidRepoUrlError);
  });

  it('rejects query strings and hash fragments', () => {
    expect(() => parseRepoUrl('https://github.com/owner/repo?ref=main')).toThrow(InvalidRepoUrlError);
    expect(() => parseRepoUrl('https://github.com/owner/repo#readme')).toThrow(InvalidRepoUrlError);
  });

  it('rejects non-string or empty inputs', () => {
    expect(() => parseRepoUrl('')).toThrow(InvalidRepoUrlError);
    expect(() => parseRepoUrl(null)).toThrow(InvalidRepoUrlError);
    expect(() => parseRepoUrl(undefined)).toThrow(InvalidRepoUrlError);
    expect(() => parseRepoUrl(12345)).toThrow(InvalidRepoUrlError);
    expect(() => parseRepoUrl({})).toThrow(InvalidRepoUrlError);
  });
});
