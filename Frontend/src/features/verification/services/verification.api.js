import axios from 'axios';

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

const api = axios.create({
  baseURL: API_BASE || undefined,
  withCredentials: true,
});

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
  const response = await api.post(
    `/api/v2/drafts/${reportId}/pdf`,
    { runId },
    { responseType: 'blob' }
  );
  return response.data;
}

/**
 * Returns absolute print URL for opening browser print dialog with strict CSP.
 */
export function getPrintDraftUrl(reportId, runId = null) {
  const query = runId ? `?runId=${runId}` : '';
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
