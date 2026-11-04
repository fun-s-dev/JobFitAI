const crypto = require('node:crypto');
const { createLimiter } = require('../utils/limiter');
const { buildRepoChunks, scoreRepo, matchLevel, rankRepos } = require('../core/repoRanking');

const EMBED_PURPOSE = 'embed_repo_ranking';
const ANALYSIS_CONCURRENCY = 3;

class RankingError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'RankingError';
    this.status = status;
    this.code = code;
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s || ''), 'utf8').digest('hex');

/**
 * Finds the user's best repositories for a job description.
 *
 *   1. list the connected account's eligible public repositories (newest push first, capped)
 *   2. analyse each one (static analysis, cached per commit; no Gemini call)
 *   3. skip repositories without a README and say so
 *   4. extract the job's requirements (one Gemini call, reused while the job description is unchanged)
 *   5. embed requirements and repository chunks, score each repository, rank them
 *   6. pre-select the top N; the user confirms or swaps the selection
 *
 * @param {object} deps
 * @param {object} deps.connectService       listRepositories / getClientForUser / resolveRepository
 * @param {object} deps.githubEvidenceService analyzeRepository
 * @param {object} deps.llmClient            embedTexts
 * @param {object} deps.requirementsService  extractRequirements
 * @param {object} deps.RankingModel
 * @param {object} deps.ReportModel
 * @param {object} deps.LinkModel            ReportProjectLink
 * @param {(update: object) => object} deps.buildLinkUpdate
 * @param {{ RANKING_MAX_REPOS?: number, RANKING_TOP_N?: number }} [deps.cfg]
 */
function createRepoRankingService({
  connectService,
  githubEvidenceService,
  llmClient,
  requirementsService,
  RankingModel,
  ReportModel,
  LinkModel,
  buildLinkUpdate,
  cfg = {},
  logger = console,
}) {
  const maxRepos = Number(cfg.RANKING_MAX_REPOS) || 15;
  const topN = Number(cfg.RANKING_TOP_N) || 4;
  const analysisLimit = createLimiter(ANALYSIS_CONCURRENCY);

  function noReadmeMessage(fullName) {
    return `${fullName} has no README, so it was skipped.`;
  }

  /**
   * @returns {Promise<object>} the saved ranking document
   */
  async function rankForReport({ userId, reportId, onProgress = null, requestId = null }) {
    const report = await ReportModel.findOne({ _id: reportId, user: userId });
    if (!report) throw new RankingError(404, 'NOT_FOUND', 'Report not found');
    const jobDescription = String(report.jobDescription || '').trim();
    if (!jobDescription) throw new RankingError(422, 'NO_JOB_DESCRIPTION', 'This plan has no job description.');

    // 1. Eligible repositories (the classification already excludes private, fork, archived, not owned)
    const { repos } = await connectService.listRepositories(String(userId));
    const eligible = repos
      .filter((r) => r.selectable)
      .sort((a, b) => new Date(b.pushedAt || 0).getTime() - new Date(a.pushedAt || 0).getTime())
      .slice(0, maxRepos);
    if (eligible.length === 0) {
      throw new RankingError(
        422,
        'NO_ELIGIBLE_REPOS',
        'No eligible repositories were found. Only public repositories you own (not forks or archived) can be used.'
      );
    }

    // 2. Requirements: reuse while the job description is unchanged, otherwise extract again
    const jobDescriptionHash = sha256(jobDescription);
    const previous = await RankingModel.findOne({ report: reportId, user: userId });
    let requirements;
    if (previous && previous.jobDescriptionHash === jobDescriptionHash && previous.requirements.length > 0) {
      requirements = previous.requirements.map((r) => ({
        text: r.text,
        importance: r.importance,
        keywords: [...(r.keywords || [])],
      }));
    } else {
      requirements = await requirementsService.extractRequirements(jobDescription, { user: String(userId), requestId });
    }

    // 3. Analyse repositories (static analysis only), a few at a time
    const total = eligible.length;
    let done = 0;
    const report_ = async () => {
      done += 1;
      if (typeof onProgress === 'function') {
        try {
          await onProgress({ done, total });
        } catch {
          // progress persistence must never fail the job
        }
      }
    };
    if (typeof onProgress === 'function') {
      try {
        await onProgress({ done: 0, total });
      } catch {
        // ignore
      }
    }

    const githubClient = await connectService.getClientForUser(String(userId));
    const analysed = await Promise.all(
      eligible.map((repo) =>
        analysisLimit(async () => {
          try {
            // No reportId/userId: analysing a candidate must not create a report link. Links are made
            // only for the repositories the user confirms.
            const { analysis } = await githubEvidenceService.analyzeRepository({
              repoUrl: repo.htmlUrl,
              githubClient,
              control: null,
            });
            return { repo, analysis, error: null };
          } catch (err) {
            if (logger && typeof logger.warn === 'function') {
              logger.warn({ errName: err && err.name, repo: repo.fullName }, 'Repository analysis failed during ranking');
            }
            return { repo, analysis: null, error: err };
          } finally {
            await report_();
          }
        })
      )
    );

    // 4. Split into ranked candidates and skipped repositories
    const skipped = [];
    const candidates = [];
    for (const item of analysed) {
      const base = {
        repoId: item.repo.repoId,
        fullName: item.repo.fullName,
        htmlUrl: item.repo.htmlUrl,
        description: item.repo.description,
        language: item.repo.language,
        pushedAt: item.repo.pushedAt ? new Date(item.repo.pushedAt) : null,
      };
      if (item.error || !item.analysis) {
        skipped.push({
          ...base,
          status: 'skipped_error',
          skipReason: `${item.repo.fullName} could not be analysed (${(item.error && item.error.message) || 'unknown error'}), so it was skipped.`,
        });
        continue;
      }
      const readme = typeof item.analysis.readmeText === 'string' ? item.analysis.readmeText.trim() : '';
      if (!readme) {
        skipped.push({
          ...base,
          analysisId: item.analysis._id,
          status: 'skipped_no_readme',
          skipReason: noReadmeMessage(item.repo.fullName),
        });
        continue;
      }
      candidates.push({ base, analysis: item.analysis });
    }

    // 5. Embed requirements + all repository chunks in one batched call, then score
    let ranked = [];
    if (candidates.length > 0) {
      const prepared = candidates.map((c) => ({ ...c, ...buildRepoChunks(c.analysis) }));
      const texts = [
        ...requirements.map((r) => r.text),
        ...prepared.flatMap((p) => p.chunks.map((c) => c.embedText)),
      ];
      const { vectors } = await llmClient.embedTexts(texts, { user: String(userId), purpose: EMBED_PURPOSE, requestId });
      const requirementVectors = vectors.slice(0, requirements.length);
      let offset = requirements.length;

      const scored = prepared.map((p) => {
        const chunkItems = p.chunks.map((chunk, i) => ({ chunk, vector: vectors[offset + i] }));
        offset += p.chunks.length;
        const result = scoreRepo({ requirements, requirementVectors, chunkItems, repoText: p.repoText });
        return {
          ...p.base,
          analysisId: p.analysis._id,
          status: 'ranked',
          ...result,
          level: matchLevel(result.score),
        };
      });
      ranked = rankRepos(scored);
    }

    // 6. Persist: ranked repositories first (by rank), then skipped ones
    const selectedRepoIds = ranked.slice(0, topN).map((r) => r.repoId);
    const doc = await RankingModel.findOneAndUpdate(
      { report: reportId },
      {
        $set: {
          user: userId,
          jobDescriptionHash,
          requirements,
          repos: [...ranked, ...skipped],
          selectedRepoIds,
          selectionConfirmedAt: null,
          rankedAt: new Date(),
        },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
    return doc;
  }

  /** The latest ranking of a report, or null. */
  async function getRanking({ userId, reportId }) {
    return RankingModel.findOne({ report: reportId, user: userId });
  }

  /**
   * Confirms the repositories to use (at most topN). Ownership is checked again against GitHub at this
   * moment (never trusted from the stored ranking), and each chosen repository is linked to the report
   * as verified evidence.
   */
  async function confirmSelection({ userId, reportId, repoIds }) {
    const ranking = await RankingModel.findOne({ report: reportId, user: userId });
    if (!ranking) throw new RankingError(404, 'NOT_FOUND', 'No ranking exists for this report yet.');

    const ids = [...new Set(repoIds)];
    if (ids.length === 0) throw new RankingError(400, 'EMPTY_SELECTION', 'Choose at least one repository.');
    if (ids.length > topN) {
      throw new RankingError(400, 'TOO_MANY_REPOS', `You can use at most ${topN} repositories.`);
    }

    const byId = new Map(ranking.repos.map((r) => [r.repoId, r]));
    for (const id of ids) {
      const entry = byId.get(id);
      if (!entry || entry.status !== 'ranked') {
        throw new RankingError(400, 'INVALID_REPO', 'Choose repositories from the ranked list.');
      }
    }

    const links = [];
    for (const id of ids) {
      const entry = byId.get(id);
      const { repo, control } = await connectService.resolveRepository(String(userId), id);
      if (!repo.selectable || !control) {
        throw new RankingError(422, 'REPO_UNSUPPORTED', repo.unsupportedMessage || 'This repository cannot be used.');
      }
      links.push({ entry, control });
    }

    for (const { entry, control } of links) {
      await LinkModel.findOneAndUpdate(
        { report: reportId, analysisId: entry.analysisId },
        buildLinkUpdate({ userId, repoUrl: entry.htmlUrl, control }),
        { upsert: true, returnDocument: 'after' }
      );
    }

    ranking.selectedRepoIds = ids;
    ranking.selectionConfirmedAt = new Date();
    await ranking.save();
    return ranking;
  }

  return { rankForReport, getRanking, confirmSelection, RankingError };
}

module.exports = { createRepoRankingService, RankingError, EMBED_PURPOSE };
