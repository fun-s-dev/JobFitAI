import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createGitHubClient,
  GitHubRateLimitError,
  RepoNotFoundError,
} = require('../../../src/v2/adapters/githubClient');

describe('adapters/githubClient (unit)', () => {
  it('creates client and decodes base64 blob content correctly', async () => {
    const mockOctokit = {
      rest: {
        git: {
          getBlob: vi.fn().mockResolvedValue({
            data: {
              content: Buffer.from('console.log("hello");').toString('base64'),
              encoding: 'base64',
            },
          }),
        },
      },
    };

    const client = createGitHubClient({ octokitInstance: mockOctokit });
    const content = await client.getBlobContent({ owner: 'user', repo: 'app', fileSha: 'sha123' });
    expect(content).toBe('console.log("hello");');
  });

  it('fetches repo metadata and supports ETag conditional request with 304 Not Modified', async () => {
    const mockOctokit = {
      rest: {
        repos: {
          get: vi.fn().mockImplementation(({ headers }) => {
            if (headers && headers['If-None-Match'] === '"cached-etag"') {
              const err = new Error('Not Modified');
              err.status = 304;
              throw err;
            }
            return {
              status: 200,
              headers: { etag: '"new-etag"' },
              data: {
                private: false,
                archived: false,
                size: 5000,
                default_branch: 'main',
              },
            };
          }),
        },
      },
    };

    const client = createGitHubClient({ octokitInstance: mockOctokit });

    // 200 fresh
    const fresh = await client.getRepoMetadata({ owner: 'user', repo: 'app' });
    expect(fresh.notModified).toBe(false);
    expect(fresh.data.default_branch).toBe('main');
    expect(fresh.etag).toBe('"new-etag"');

    // 304 not modified
    const cached = await client.getRepoMetadata({ owner: 'user', repo: 'app', etag: '"cached-etag"' });
    expect(cached.notModified).toBe(true);
    expect(cached.status).toBe(304);
  });

  it('translates 403 / 429 errors to typed GitHubRateLimitError with resetTime', async () => {
    const rateLimitErr = new Error('API rate limit exceeded');
    rateLimitErr.status = 403;
    rateLimitErr.response = {
      headers: {
        'x-ratelimit-reset': '1700000000',
        'x-ratelimit-remaining': '0',
      },
    };

    const mockOctokit = {
      rest: {
        repos: {
          get: vi.fn().mockRejectedValue(rateLimitErr),
        },
      },
    };

    const client = createGitHubClient({ octokitInstance: mockOctokit });
    await expect(client.getRepoMetadata({ owner: 'user', repo: 'app' })).rejects.toThrow(GitHubRateLimitError);
  });

  it('translates 404 errors to typed RepoNotFoundError', async () => {
    const notFoundErr = new Error('Not Found');
    notFoundErr.status = 404;

    const mockOctokit = {
      rest: {
        repos: {
          get: vi.fn().mockRejectedValue(notFoundErr),
        },
      },
    };

    const client = createGitHubClient({ octokitInstance: mockOctokit });
    await expect(client.getRepoMetadata({ owner: 'user', repo: 'app' })).rejects.toThrow(RepoNotFoundError);
  });

  it('fetches tree and respects truncated flag', async () => {
    const mockOctokit = {
      rest: {
        git: {
          getTree: vi.fn().mockResolvedValue({
            data: {
              sha: 'tree123',
              truncated: true,
              tree: [
                { path: 'package.json', type: 'blob', size: 120 },
              ],
            },
          }),
        },
      },
    };

    const client = createGitHubClient({ octokitInstance: mockOctokit });
    const result = await client.getTree({ owner: 'user', repo: 'app', treeSha: 'sha1' });
    expect(result.truncated).toBe(true);
    expect(result.tree.length).toBe(1);
    expect(result.tree[0].path).toBe('package.json');
  });
});
