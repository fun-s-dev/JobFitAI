const path = require('node:path');
const { parseRepoUrl } = require('../core/parseRepoUrl');
const { filterAllowedTree } = require('../core/isAllowedPath');
const { scrubSecrets } = require('../core/scrubSecrets');
const { extractDependenciesFromContent } = require('../core/dependencyParsers');
const { analyzeSourceFile, analyzeReadme } = require('./astAnalysis');
const {
  createGitHubClient,
  RepoNotFoundError,
  GitHubRateLimitError,
} = require('../adapters/githubClient');
const DefaultGithubAnalysis = require('../models/githubAnalysis');
const DefaultReportProjectLink = require('../models/reportProjectLink.model');

/**
 * Creates GitHub evidence service with dependency injection.
 */
function createGitHubEvidenceService(deps = {}) {
  const client = deps.githubClient || createGitHubClient();
  const AnalysisModel = deps.GithubAnalysis || DefaultGithubAnalysis;
  const LinkModel = deps.ReportProjectLink || DefaultReportProjectLink;

  /**
   * Analyzes a public GitHub repository and caches evidence items.
   *
   * @param {object} params
   * @param {string} params.repoUrl
   * @param {string} [params.reportId]
   * @param {string} [params.userId]
   * @param {Function} [params.onProgress] - ({ done, total }) => void
   * @returns {Promise<{ analysis: object, cached: boolean }>}
   */
  async function analyzeRepository({ repoUrl, reportId, userId, onProgress }) {
    // 1. Validate URL strictly
    const { owner, repo, repositoryFullName } = parseRepoUrl(repoUrl);

    // 2. Fetch metadata
    let meta;
    try {
      meta = await client.getRepoMetadata({ owner, repo });
    } catch (err) {
      if (err instanceof RepoNotFoundError) {
        // Deleted or made private repo -> mark existing cached analyses stale
        await AnalysisModel.updateMany(
          { repositoryFullName },
          { $set: { analysisStatus: 'stale' } }
        );
      } else if (err instanceof GitHubRateLimitError) {
        // SPEC: 403/429 RateLimitError serves the cached analysis if any
        const existingCache = await AnalysisModel.findOne({ repositoryFullName, analysisStatus: 'complete' }).sort({ createdAt: -1 });
        if (existingCache) {
          if (reportId && userId) {
            await LinkModel.findOneAndUpdate(
              { report: reportId, analysisId: existingCache._id },
              { $set: { user: userId, repoUrl, linkedAt: new Date() } },
              { upsert: true, returnDocument: 'after' }
            );
          }
          return { analysis: existingCache, cached: true };
        }
      }
      throw err;
    }

    if (meta.data.private) {
      throw new Error('Repository is private. Only public repositories can be analyzed.');
    }

    if (meta.data.archived) {
      throw new Error('Repository is archived. Only active repositories can be analyzed.');
    }

    if (meta.data.size > 500000) {
      throw new Error('Repository exceeds maximum size limit (500 MB).');
    }

    // 3. Head commit SHA
    const defaultBranch = meta.data.default_branch || 'main';
    let commitSha;
    try {
      commitSha = await client.getHeadCommitSha({ owner, repo, branch: defaultBranch });
    } catch (err) {
      if (err instanceof GitHubRateLimitError) {
        const existingCache = await AnalysisModel.findOne({ repositoryFullName, analysisStatus: 'complete' }).sort({ createdAt: -1 });
        if (existingCache) {
          if (reportId && userId) {
            await LinkModel.findOneAndUpdate(
              { report: reportId, analysisId: existingCache._id },
              { $set: { user: userId, repoUrl, linkedAt: new Date() } },
              { upsert: true, returnDocument: 'after' }
            );
          }
          return { analysis: existingCache, cached: true };
        }
      }
      throw err;
    }

    // 4. Cache lookup: compound unique index { repositoryFullName, commitSha }
    const cachedDoc = await AnalysisModel.findOne({ repositoryFullName, commitSha });
    if (cachedDoc && cachedDoc.analysisStatus === 'complete') {
      if (reportId && userId) {
        await LinkModel.findOneAndUpdate(
          { report: reportId, analysisId: cachedDoc._id },
          { $set: { user: userId, repoUrl, linkedAt: new Date() } },
          { upsert: true, returnDocument: 'after' }
        );
      }
      return { analysis: cachedDoc, cached: true };
    }

    // 5. Languages
    const languages = await client.listLanguages({ owner, repo });

    // 6. Tree fetch and allowlist filtering (caps: 40 files, 500 KB)
    const treeResult = await client.getTree({ owner, repo, treeSha: commitSha, recursive: true });
    const allowedEntries = filterAllowedTree(treeResult.tree || []);

    const dependencies = [];
    const evidenceItems = [];
    const readmes = [];
    const backedSkills = new Set();

    // 7. Blob fetching and AST/dependency parsing
    for (let i = 0; i < allowedEntries.length; i++) {
      const entry = allowedEntries[i];
      if (typeof onProgress === 'function') {
        onProgress({ done: i + 1, total: allowedEntries.length });
      }

      const rawBlob = await client.getBlobContent({ owner, repo, fileSha: entry.sha });
      const cleanText = scrubSecrets(rawBlob);
      const baseName = path.basename(entry.path).toLowerCase();

      if (baseName === 'package.json' || baseName === 'requirements.txt') {
        const parsed = extractDependenciesFromContent(entry.path, cleanText);
        dependencies.push(...parsed.dependencies);
        evidenceItems.push(...parsed.evidenceItems);
        for (const item of parsed.evidenceItems) {
          backedSkills.add(item.skill);
        }
      } else if (baseName.startsWith('readme')) {
        readmes.push({ path: entry.path, content: cleanText });
      } else {
        const astHits = analyzeSourceFile(entry.path, cleanText);
        evidenceItems.push(...astHits);
        for (const hit of astHits) {
          backedSkills.add(hit.skill);
        }
      }
    }

    // 8. README analysis with contradiction detection
    for (const r of readmes) {
      const readmeHits = analyzeReadme(r.content, r.path, backedSkills);
      evidenceItems.push(...readmeHits);
    }

    // 9. Persist analysis
    const updatePayload = {
      repositoryUrl: repoUrl,
      repositoryFullName,
      commitSha,
      defaultBranch,
      languages,
      dependencies,
      evidenceItems,
      analysisStatus: 'complete',
      etag: meta.etag || null,
      analyzedAt: new Date(),
    };

    const savedAnalysis = await AnalysisModel.findOneAndUpdate(
      { repositoryFullName, commitSha },
      { $set: updatePayload },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );

    // 10. Link to report
    if (reportId && userId) {
      await LinkModel.findOneAndUpdate(
        { report: reportId, analysisId: savedAnalysis._id },
        { $set: { user: userId, repoUrl, linkedAt: new Date() } },
        { upsert: true, returnDocument: 'after' }
      );
    }

    return { analysis: savedAnalysis, cached: false };
  }

  return {
    analyzeRepository,
  };
}

const defaultService = createGitHubEvidenceService();

module.exports = {
  createGitHubEvidenceService,
  githubEvidenceService: defaultService,
};
