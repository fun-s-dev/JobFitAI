/**
 * User data deletion: a report with everything derived from it, or a whole account.
 *
 * Resume text is personal data, so users must be able to remove it. Deletion is ordered
 * children-first and is idempotent: if it stops half-way the parent record still exists and the
 * request can simply be repeated.
 *
 * Not deleted on purpose:
 *  - githubanalyses : a shared cache of PUBLIC repository data, not linked to a user.
 *  - embeddingcaches: keyed by content hash, not linked to a user (expires after its TTL).
 *  - llmcalls       : kept for the budget ledger, but unlinked from the user (user = null).
 */

class UserDataError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'UserDataError';
    this.status = status;
    this.code = code;
  }
}

const ACTIVE_JOB_MESSAGE =
  'A verification or GitHub analysis is still running. Please wait for it to finish, then try again.';

/**
 * @param {object} deps
 * @param {object} deps.models  InterviewReport, ResumeDraft, VerificationRun, ResumeClaim, Job,
 *   ReportProjectLink, LlmCall, GithubOauthState, User
 * @param {(userId: string) => Promise<void>} [deps.disconnectGithub] revokes and removes a GitHub connection
 */
function createUserDataService({ models, disconnectGithub = async () => {} }) {
  const {
    InterviewReport,
    ResumeDraft,
    VerificationRun,
    ResumeClaim,
    Job,
    ReportProjectLink,
    RepoRanking,
    LlmCall,
    GithubOauthState,
    User,
  } = models;

  const ACTIVE = { $in: ['queued', 'running'] };

  /** Deletes one report and everything derived from it. 404 if it is not the caller's. */
  async function deleteReport({ reportId, userId }) {
    const report = await InterviewReport.findOne({ _id: reportId, user: userId }).select('_id');
    if (!report) {
      throw new UserDataError(404, 'NOT_FOUND', 'Interview report not found.');
    }

    if (await Job.exists({ report: report._id, status: ACTIVE })) {
      throw new UserDataError(409, 'JOB_IN_PROGRESS', ACTIVE_JOB_MESSAGE);
    }

    const counts = {};
    counts.claims = (await ResumeClaim.deleteMany({ report: report._id })).deletedCount;
    counts.runs = (await VerificationRun.deleteMany({ report: report._id })).deletedCount;
    counts.drafts = (await ResumeDraft.deleteMany({ report: report._id })).deletedCount;
    counts.repositoryLinks = (await ReportProjectLink.deleteMany({ report: report._id })).deletedCount;
    if (RepoRanking) counts.rankings = (await RepoRanking.deleteMany({ report: report._id })).deletedCount;
    counts.jobs = (await Job.deleteMany({ report: report._id })).deletedCount;
    await InterviewReport.deleteOne({ _id: report._id });
    counts.reports = 1;

    return { deleted: true, counts };
  }

  /** Deletes the user, all their data, and their GitHub connection. */
  async function deleteAccount({ userId }) {
    if (await Job.exists({ user: userId, status: ACTIVE })) {
      throw new UserDataError(409, 'JOB_IN_PROGRESS', ACTIVE_JOB_MESSAGE);
    }

    const counts = {};
    counts.claims = (await ResumeClaim.deleteMany({ user: userId })).deletedCount;
    counts.runs = (await VerificationRun.deleteMany({ user: userId })).deletedCount;
    counts.drafts = (await ResumeDraft.deleteMany({ user: userId })).deletedCount;
    counts.repositoryLinks = (await ReportProjectLink.deleteMany({ user: userId })).deletedCount;
    if (RepoRanking) counts.rankings = (await RepoRanking.deleteMany({ user: userId })).deletedCount;
    counts.jobs = (await Job.deleteMany({ user: userId })).deletedCount;
    counts.reports = (await InterviewReport.deleteMany({ user: userId })).deletedCount;

    await disconnectGithub(String(userId));
    await GithubOauthState.deleteMany({ user: userId });
    await LlmCall.updateMany({ user: userId }, { $set: { user: null } });
    await User.deleteOne({ _id: userId });

    return { deleted: true, counts };
  }

  return { deleteReport, deleteAccount };
}

module.exports = { createUserDataService, UserDataError };
