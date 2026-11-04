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

// Upper bound on the README text kept per analysis (about 30 retrieval chunks of 400 characters)
const MAX_README_CHARS = 12000;

/**
 * Builds the ReportProjectLink upsert for an analysis.
 * Control evidence (is the repository controlled by the user's verified GitHub account?) is recorded on
 * the link. A verified link is never downgraded by a later unverified (pasted URL) request.
 * Authorship is never assessed here.
 */
function buildLinkUpdate({ userId, repoUrl, control }) {
  const base = { user: userId, repoUrl, linkedAt: new Date() };
  if (control && control.verified === true) {
    return { $set: { ...base, control, authorship: 'not_assessed' } };
  }
  return {
    $set: base,
    $setOnInsert: { control: { verified: false, method: 'pasted_public_url' }, authorship: 'not_assessed' },
  };
}
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
  async function analyzeRepository({ repoUrl, reportId, userId, onProgress, githubClient: clientOverride = null, control = null }) {
    // A per-call client lets verified users read with their own (higher-limit) GitHub token
    const gh = clientOverride || client;
    // 1. Validate URL strictly
    const { owner, repo, repositoryFullName } = parseRepoUrl(repoUrl);

    // 2. Fetch metadata
    let meta;
    try {
      meta = await gh.getRepoMetadata({ owner, repo });
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
              buildLinkUpdate({ userId, repoUrl, control }),
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
      commitSha = await gh.getHeadCommitSha({ owner, repo, branch: defaultBranch });
    } catch (err) {
      if (err instanceof GitHubRateLimitError) {
        const existingCache = await AnalysisModel.findOne({ repositoryFullName, analysisStatus: 'complete' }).sort({ createdAt: -1 });
        if (existingCache) {
          if (reportId && userId) {
            await LinkModel.findOneAndUpdate(
              { report: reportId, analysisId: existingCache._id },
              buildLinkUpdate({ userId, repoUrl, control }),
              { upsert: true, returnDocument: 'after' }
            );
          }
          return { analysis: existingCache, cached: true };
        }
      }
      throw err;
    }

    // 4. Cache lookup: compound unique index { repositoryFullName, commitSha }
    // An analysis stored before the README was kept (readmeChecked false) is re-run once to fill it in.
    const cachedDoc = await AnalysisModel.findOne({ repositoryFullName, commitSha });
    if (cachedDoc && cachedDoc.analysisStatus === 'complete' && cachedDoc.readmeChecked === true) {
      if (reportId && userId) {
        await LinkModel.findOneAndUpdate(
          { report: reportId, analysisId: cachedDoc._id },
          buildLinkUpdate({ userId, repoUrl, control }),
          { upsert: true, returnDocument: 'after' }
        );
      }
      return { analysis: cachedDoc, cached: true };
    }

    // 5. Languages
    const languages = await gh.listLanguages({ owner, repo });

    // 6. Tree fetch and allowlist filtering (caps: 40 files, 500 KB)
    const treeResult = await gh.getTree({ owner, repo, treeSha: commitSha, recursive: true });
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

      const rawBlob = await gh.getBlobContent({ owner, repo, fileSha: entry.sha });
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

    // 8.5 Keep the primary README (the one closest to the repository root) for ranking and retrieval
    const primaryReadme = readmes
      .filter((r) => typeof r.content === 'string' && r.content.trim().length > 0)
      .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))[0];

    // 9. Persist analysis
    const updatePayload = {
      repositoryUrl: repoUrl,
      repositoryFullName,
      commitSha,
      defaultBranch,
      languages,
      dependencies,
      evidenceItems,
      description: typeof meta.data.description === 'string' ? meta.data.description.slice(0, 300) : null,
      readmePath: primaryReadme ? primaryReadme.path : null,
      readmeText: primaryReadme ? primaryReadme.content.slice(0, MAX_README_CHARS) : null,
      readmeChecked: true,
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
        buildLinkUpdate({ userId, repoUrl, control }),
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
  buildLinkUpdate,
  MAX_README_CHARS,
};
