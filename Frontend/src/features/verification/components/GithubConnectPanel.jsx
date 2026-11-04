import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getGithubConnection,
  startGithubConnect,
  listGithubRepos,
  disconnectGithub,
  startGitHubRepoAnalysis,
  getGitHubAnalysis,
} from '../services/verification.api';
import { useJob } from '../hooks/useJob';
import { isGithubAuthorizeUrl } from '../utils/githubConnectMessages';
import { getApiErrorMessage } from '../../../services/apiError';

/**
 * GitHub evidence: "Connect GitHub" (GitHub App user authorization) + repository selection.
 *
 * What a connection proves: the repositories listed are owned by the GitHub account that the user
 * authorized. It does NOT prove the user wrote the code in them. Connecting is the only way to add
 * repository evidence (there is no pasted-URL mode).
 *
 * @param {object} props
 * @param {string} props.reportId
 * @param {(analysis: object, control: object) => void} [props.onAnalysisComplete]
 * @param {(url: string) => void} [props.navigate] Test seam; defaults to a full-page redirect
 */
export default function GithubConnectPanel({
  reportId,
  onAnalysisComplete,
  navigate = (url) => window.location.assign(url),
}) {
  const queryClient = useQueryClient();
  const [selectedRepoId, setSelectedRepoId] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [activeJobId, setActiveJobId] = useState(null);
  const [completed, setCompleted] = useState(null);

  const connectionQuery = useQuery({
    queryKey: ['githubConnection'],
    queryFn: getGithubConnection,
    retry: false,
  });
  const connection = connectionQuery.data;
  const isConnected = Boolean(connection?.connected);

  const reposQuery = useQuery({
    queryKey: ['githubRepos'],
    queryFn: listGithubRepos,
    enabled: isConnected,
    retry: false,
  });

  const activeJob = useJob(activeJobId, {
    onDone: async (job) => {
      try {
        if (job.resultRef) {
          const data = await getGitHubAnalysis(job.resultRef);
          setCompleted({ analysis: data.analysis, control: data.control });
          if (typeof onAnalysisComplete === 'function') {
            onAnalysisComplete(data.analysis, data.control);
          }
        }
      } catch (err) {
        setActionError(getApiErrorMessage(err, 'The analysis finished but could not be loaded.'));
      }
    },
    onFailed: (job) => {
      setActionError(job.error?.message || 'GitHub analysis failed.');
    },
  });
  const isJobActive = activeJob.isRunning;

  const handleConnect = async () => {
    setActionError(null);
    setIsConnecting(true);
    try {
      const { authorizeUrl } = await startGithubConnect(`/interview/${reportId}/verify`);
      if (!isGithubAuthorizeUrl(authorizeUrl)) {
        throw new Error('Unexpected authorization address received.');
      }
      navigate(authorizeUrl);
    } catch (err) {
      setActionError(getApiErrorMessage(err, 'Could not start the GitHub connection.'));
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setActionError(null);
    try {
      await disconnectGithub();
      setSelectedRepoId(null);
      queryClient.removeQueries({ queryKey: ['githubRepos'] });
      await queryClient.invalidateQueries({ queryKey: ['githubConnection'] });
    } catch (err) {
      setActionError(getApiErrorMessage(err, 'Could not disconnect GitHub.'));
    }
  };

  const handleAnalyze = async () => {
    if (selectedRepoId === null) return;
    setActionError(null);
    setCompleted(null);
    setIsStarting(true);
    try {
      const res = await startGitHubRepoAnalysis(reportId, selectedRepoId);
      if (res.jobId) setActiveJobId(res.jobId);
    } catch (err) {
      setActionError(getApiErrorMessage(err, 'Could not start the repository analysis.'));
      // The connection may have expired or been revoked: refresh what we show
      queryClient.invalidateQueries({ queryKey: ['githubConnection'] });
    } finally {
      setIsStarting(false);
    }
  };

  const repos = reposQuery.data?.repos || [];
  const reposError = reposQuery.isError ? getApiErrorMessage(reposQuery.error, 'Could not load your repositories.') : null;

  return (
    <section className="connect-section" aria-label="GitHub repository evidence">
      <p className="vp-panel__desc">
        Connecting GitHub shows that you <strong>control</strong> a repository. It does not prove that you
        wrote the code in it. Repositories are read without executing any code.
      </p>

      {connectionQuery.isLoading && <p className="vp-panel__desc">Checking GitHub connection…</p>}
      {connectionQuery.isError && (
        <div className="vp-alert vp-alert--error" role="alert">
          <span className="vp-alert__icon" aria-hidden="true">⚠</span>
          <span className="vp-alert__body">
            {getApiErrorMessage(connectionQuery.error, 'Could not check the GitHub connection.')}
          </span>
        </div>
      )}

      {connection && connection.configured === false && (
        <div className="vp-alert vp-alert--info">
          <span className="vp-alert__icon" aria-hidden="true">ℹ</span>
          <span className="vp-alert__body">
            GitHub Connect is not set up on this server, so repositories cannot be added as evidence. Your
            resume alone is used for verification.
          </span>
        </div>
      )}

      {connection && connection.configured && !isConnected && (
        <div className="connect-card">
          <div>
            {connection.needsReconnect && (
              <div className="vp-alert vp-alert--error" role="alert" style={{ marginBottom: '0.75rem' }}>
                <span className="vp-alert__icon" aria-hidden="true">⚠</span>
                <span className="vp-alert__body">
                  Your GitHub connection expired or was revoked. Please connect again.
                </span>
              </div>
            )}
            <p className="connect-card__note">
              You will authorize JobFitAI on GitHub. It requests no repository permissions: it only learns who you are
              and which public repositories you own.
            </p>
          </div>
          <button type="button" className="vp-btn vp-btn--primary" onClick={handleConnect} disabled={isConnecting}>
            {isConnecting ? 'Redirecting to GitHub…' : connection.needsReconnect ? 'Reconnect GitHub' : 'Connect GitHub'}
          </button>
        </div>
      )}

      {isConnected && (
        <div className="connect-card">
          <span className="connect-card__who">
            <span className="connect-card__dot" aria-hidden="true" />
            <span>
              Connected as <strong>@{connection.login}</strong>
            </span>
          </span>
          <button type="button" className="vp-btn vp-btn--ghost" onClick={handleDisconnect}>
            Disconnect
          </button>
        </div>
      )}

      {isConnected && (
        <details className="vp-details">
          <summary>Advanced: link a single repository by hand</summary>
          <div className="vp-details__body">
            <p className="connect-card__note">
              Normally you do not need this: use “Best projects for this job” below. Linking one repository here is
              useful to back up a project from your resume.
            </p>

            {reposQuery.isLoading && <p className="vp-panel__desc">Loading your public repositories…</p>}
            {reposError && (
              <div className="vp-alert vp-alert--error" role="alert">
                <span className="vp-alert__icon" aria-hidden="true">⚠</span>
                <span className="vp-alert__body">{reposError}</span>
              </div>
            )}

            {reposQuery.isSuccess && repos.length === 0 && (
              <p className="vp-panel__desc">No public repositories were found on this account.</p>
            )}

            {repos.length > 0 && (
              <ul className="repo-radio-list" aria-label="Your public repositories">
                {repos.map((repo) => (
                  <li key={repo.repoId}>
                    <label className={`repo-radio${repo.selectable ? '' : ' repo-radio--disabled'}`}>
                      <input
                        type="radio"
                        name="github-repo"
                        value={repo.repoId}
                        checked={selectedRepoId === repo.repoId}
                        disabled={!repo.selectable || isJobActive || isStarting}
                        onChange={() => setSelectedRepoId(repo.repoId)}
                        aria-label={`Select ${repo.fullName}`}
                      />
                      <span>
                        <span className="repo-radio__name">{repo.fullName}</span>
                        <small className="repo-radio__meta">
                          Public
                          {repo.control?.verified ? ' · you own this repository' : ''}
                          {repo.isFork ? ' · fork' : ''}
                          {repo.isArchived ? ' · archived' : ''}
                        </small>
                        {repo.description && <span className="repo-radio__desc" style={{ display: 'block' }}>{repo.description}</span>}
                        {!repo.selectable && repo.unsupportedMessage && (
                          <span className="repo-radio__warn" style={{ display: 'block' }}>{repo.unsupportedMessage}</span>
                        )}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}

            <p className="connect-card__note">
              Private repositories are not supported in this version and are not listed. Organization and
              collaborator repositories are not supported yet.
            </p>

            <div>
              <button
                type="button"
                className="vp-btn vp-btn--secondary"
                onClick={handleAnalyze}
                disabled={selectedRepoId === null || isStarting || isJobActive}
              >
                {isStarting || isJobActive ? 'Analyzing…' : 'Analyze selected repository'}
              </button>
            </div>
          </div>
        </details>
      )}

      {isJobActive && (
        <div className="vp-alert vp-alert--info" role="status">
          <span className="vp-alert__icon" aria-hidden="true">⏳</span>
          <span className="vp-alert__body">
            {activeJob.job?.status === 'queued' ? 'Queued…' : 'Scanning repository…'}
            {activeJob.totalCount > 0 ? ` ${activeJob.doneCount} / ${activeJob.totalCount} files` : ''}
          </span>
        </div>
      )}

      {actionError && (
        <div className="vp-alert vp-alert--error" role="alert">
          <span className="vp-alert__icon" aria-hidden="true">⚠</span>
          <span className="vp-alert__body">{actionError}</span>
        </div>
      )}

      {completed && (
        <div className="vp-alert vp-alert--success" role="status">
          <span className="vp-alert__icon" aria-hidden="true">✓</span>
          <span className="vp-alert__body">
            Linked {completed.analysis?.repositoryFullName}.{' '}
            {completed.control?.verified
              ? `Ownership verified: this repository belongs to your GitHub account (@${completed.control.githubLogin}). It counts toward verification. Authorship of the code is not verified.`
              : 'Ownership was not verified, so this repository does not count toward verification.'}
          </span>
        </div>
      )}
    </section>
  );
}
