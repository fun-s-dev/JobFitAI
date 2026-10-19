class GitHubRateLimitError extends Error {
  constructor(message = 'GitHub API rate limit exceeded', resetEpoch = null, status = 403) {
    super(message);
    this.name = 'GitHubRateLimitError';
    this.status = status;
    this.resetEpoch = resetEpoch;
  }
}

class RepoNotFoundError extends Error {
  constructor(message = 'GitHub repository not found or is private') {
    super(message);
    this.name = 'RepoNotFoundError';
    this.status = 404;
  }
}

class GitHubApiError extends Error {
  constructor(message = 'GitHub API error', status = 500) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

/**
 * Creates a GitHub API client wrapper.
 * Dynamically imports ESM-only @octokit/rest.
 *
 * @param {object} [options]
 * @param {string} [options.token] - Optional personal access token
 * @param {object} [options.octokitInstance] - Pre-instantiated Octokit (for unit tests)
 */
function createGitHubClient(options = {}) {
  let octokitPromise = null;

  async function getOctokit() {
    if (options.octokitInstance) {
      return options.octokitInstance;
    }
    if (!octokitPromise) {
      octokitPromise = (async () => {
        const { Octokit } = await import('@octokit/rest');
        const token = options.token || process.env.GITHUB_TOKEN;
        return new Octokit({
          auth: token || undefined,
          userAgent: 'JobFitAI-v2/1.0',
        });
      })();
    }
    return octokitPromise;
  }

  function handleHttpError(err) {
    const status = err.status || err.response?.status;
    if (status === 304) {
      return null;
    }
    if (status === 403 || status === 429) {
      const resetHeader =
        err.response?.headers?.['x-ratelimit-reset'] ||
        err.headers?.['x-ratelimit-reset'];
      const resetEpoch = resetHeader ? parseInt(resetHeader, 10) : null;
      throw new GitHubRateLimitError(err.message || 'GitHub rate limit exceeded', resetEpoch, status);
    }
    if (status === 404) {
      throw new RepoNotFoundError(err.message || 'Repository not found or access denied');
    }
    throw new GitHubApiError(err.message || 'GitHub request failed', status || 500);
  }

  /**
   * Fetches repo metadata with optional conditional request (ETag).
   */
  async function getRepoMetadata({ owner, repo, etag }) {
    const octokit = await getOctokit();
    const headers = {};
    if (etag) {
      headers['If-None-Match'] = etag;
    }

    try {
      const res = await octokit.rest.repos.get({
        owner,
        repo,
        headers,
      });

      return {
        notModified: false,
        status: res.status,
        data: res.data,
        etag: res.headers?.etag || null,
      };
    } catch (err) {
      if (err.status === 304) {
        return {
          notModified: true,
          status: 304,
          data: null,
          etag,
        };
      }
      handleHttpError(err);
    }
  }

  /**
   * Fetches languages byte map.
   */
  async function listLanguages({ owner, repo }) {
    const octokit = await getOctokit();
    try {
      const res = await octokit.rest.repos.listLanguages({ owner, repo });
      return res.data;
    } catch (err) {
      handleHttpError(err);
    }
  }

  /**
   * Gets HEAD commit SHA for a branch.
   */
  async function getHeadCommitSha({ owner, repo, branch }) {
    const octokit = await getOctokit();
    try {
      const res = await octokit.rest.repos.getBranch({ owner, repo, branch });
      return res.data.commit.sha;
    } catch (err) {
      handleHttpError(err);
    }
  }

  /**
   * Fetches git tree, respecting the truncated flag.
   */
  async function getTree({ owner, repo, treeSha, recursive = true }) {
    const octokit = await getOctokit();
    try {
      const res = await octokit.rest.git.getTree({
        owner,
        repo,
        tree_sha: treeSha,
        recursive: recursive ? 'true' : undefined,
      });
      return {
        tree: res.data.tree || [],
        truncated: Boolean(res.data.truncated),
        sha: res.data.sha,
      };
    } catch (err) {
      handleHttpError(err);
    }
  }

  /**
   * Fetches blob content and decodes base64.
   */
  async function getBlobContent({ owner, repo, fileSha }) {
    const octokit = await getOctokit();
    try {
      const res = await octokit.rest.git.getBlob({
        owner,
        repo,
        file_sha: fileSha,
      });

      if (!res.data || !res.data.content) {
        return '';
      }

      if (res.data.encoding === 'base64') {
        return Buffer.from(res.data.content, 'base64').toString('utf8');
      }

      return String(res.data.content);
    } catch (err) {
      handleHttpError(err);
    }
  }

  return {
    getRepoMetadata,
    listLanguages,
    getHeadCommitSha,
    getTree,
    getBlobContent,
  };
}

module.exports = {
  createGitHubClient,
  GitHubRateLimitError,
  RepoNotFoundError,
  GitHubApiError,
};
