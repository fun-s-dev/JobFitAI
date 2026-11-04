import { api, API_BASE } from '../../../services/apiClient';

/**
 * With responseType 'blob', axios delivers JSON error bodies as a Blob.
 * Parse it back into an object so callers can read err.response.data.error.message.
 */
async function parseBlobErrorBody(err) {
  const data = err?.response?.data;
  if (data && typeof data.text === 'function') {
    try {
      err.response.data = JSON.parse(await data.text());
    } catch {
      // Not JSON (e.g. proxy HTML error page): leave the body as-is
    }
  }
  return err;
}

/**
 * Initiates an async verification run for a report. Returns 202 { jobId, status, progress }
 */
export async function startVerificationJob(reportId, options = {}) {
  const response = await api.post(`/api/v2/verification/${reportId}`, options);
  return response.data;
}

/**
 * Polls state and progress of an active background job.
 */
export async function getJobById(jobId) {
  const response = await api.get(`/api/v2/jobs/${jobId}`);
  return response.data;
}

/**
 * Fetches latest (or specific runId) verification run and claims for a report.
 */
export async function getVerificationRun(reportId, runId = null) {
  const url = runId
    ? `/api/v2/verification/${reportId}?runId=${runId}`
    : `/api/v2/verification/${reportId}`;
  const response = await api.get(url);
  return response.data;
}

/**
 * Updates user decision override for a claim ('approved' or 'rejected').
 */
export async function updateClaimOverride(claimId, decision) {
  const response = await api.patch(`/api/v2/verification/claim/${claimId}`, { decision });
  return response.data;
}

/**
 * Fetches grounded draft breakdown metadata (allowed/excluded bullets and reasons).
 */
export async function getGroundedDraft(reportId, runId = null) {
  const url = runId
    ? `/api/v2/drafts/${reportId}/grounded?runId=${runId}`
    : `/api/v2/drafts/${reportId}/grounded`;
  const response = await api.get(url);
  return response.data;
}

/**
 * Triggers server-side PDF export via Puppeteer.
 */
export async function downloadGroundedPdf(reportId, runId = null) {
  try {
    const response = await api.post(
      `/api/v2/drafts/${reportId}/pdf`,
      runId ? { runId } : {},
      { responseType: 'blob' }
    );
    return response.data;
  } catch (err) {
    throw await parseBlobErrorBody(err);
  }
}

/**
 * Returns absolute print URL for opening browser print dialog with strict CSP.
 */
export function getPrintDraftUrl(reportId, runId = null) {
  const query = runId ? `?runId=${encodeURIComponent(runId)}` : '';
  const path = `/api/v2/drafts/${reportId}/print${query}`;
  return API_BASE ? `${API_BASE}${path}` : path;
}

/**
 * Helper to generate a new draft for a report if one is missing.
 */
export async function createDraftForReport(reportId) {
  const response = await api.post(`/api/v2/drafts/${reportId}`);
  return response.data;
}

/**
 * Latest saved draft for a report, or null when none has been generated yet (404).
 */
export async function getLatestDraft(reportId) {
  try {
    const response = await api.get(`/api/v2/drafts/${reportId}`);
    return response.data?.draft || null;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

/**
 * Repositories linked to this report (persisted on the server) with the draft project each one belongs to:
 * { links: [{ analysisId, repositoryFullName, verified, explicitProjectName, matchedProject, matchSource }],
 *   draftProjects: string[], hasDraft: boolean }
 */
export async function getReportGithubLinks(reportId) {
  const response = await api.get(`/api/v2/github/links/${reportId}`);
  return response.data;
}

/**
 * Starts the background job that analyses the user's repositories and ranks them against the
 * report's job description. Returns 202 { jobId, status }.
 */
export async function startRepoRanking(reportId) {
  const response = await api.post(`/api/v2/github/ranking/${reportId}`, {});
  return response.data;
}

/**
 * Latest ranking of a report: { ranking: null | { requirements, repos, selectedRepoIds, selectionConfirmedAt }, topN }
 */
export async function getRepoRanking(reportId) {
  const response = await api.get(`/api/v2/github/ranking/${reportId}`);
  return response.data;
}

/**
 * Confirms which ranked repositories to use (the server links them to the report).
 */
export async function confirmRepoSelection(reportId, repoIds) {
  const response = await api.put(`/api/v2/github/ranking/${reportId}/selection`, { repoIds });
  return response.data;
}

/**
 * Chooses which draft project a linked repository belongs to (null = back to automatic matching).
 */
export async function setGithubLinkProject(reportId, analysisId, projectName) {
  const response = await api.put(`/api/v2/github/links/${analysisId}/project`, { reportId, projectName });
  return response.data;
}

/**
 * Fetches an analysis record by analysisId.
 * Response: { analysis, control: { verified, method, githubLogin }, authorship: 'not_assessed' }
 */
export async function getGitHubAnalysis(analysisId) {
  const response = await api.get(`/api/v2/github/analysis/${analysisId}`);
  return response.data;
}

// ---- GitHub Connect (tokens never reach the browser; these calls only carry the session cookie) ----

/**
 * Connection status: { configured, connected, needsReconnect?, login?, avatarUrl?, connectedAt? }
 */
export async function getGithubConnection() {
  const response = await api.get('/api/v2/github/connection');
  return response.data.connection;
}

/**
 * Starts the GitHub authorization. Returns { authorizeUrl } - the page must navigate to it.
 */
export async function startGithubConnect(returnTo) {
  const response = await api.post('/api/v2/github/connect/start', returnTo ? { returnTo } : {});
  return response.data;
}

/**
 * Public repositories owned by the connected account, each classified:
 * { login, repos: [{ repoId, fullName, selectable, unsupportedReason, unsupportedMessage, control, ... }], scope }
 */
export async function listGithubRepos() {
  const response = await api.get('/api/v2/github/repos');
  return response.data;
}

export async function disconnectGithub() {
  const response = await api.delete('/api/v2/github/connection');
  return response.data;
}

/**
 * Analyzes a repository selected from the connected account. Ownership is verified by the server.
 */
export async function startGitHubRepoAnalysis(reportId, repoId) {
  const response = await api.post('/api/v2/github/analyze', { reportId, repoId });
  return response.data;
}
