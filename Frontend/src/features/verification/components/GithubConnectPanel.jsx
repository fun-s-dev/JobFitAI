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

const sectionStyle = { marginBottom: '1.5rem' };
const noteStyle = { fontSize: '0.85rem', color: '#9aa4b2', margin: '0.5rem 0' };
const errorStyle = { color: '#ff6b6b', fontSize: '0.9rem', margin: '0.5rem 0' };

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
    <section className="github-connect-panel" aria-label="GitHub repository evidence" style={sectionStyle}>
      <h3 className="github-link-form__title">GitHub repository evidence</h3>
      <p style={noteStyle}>
        Connecting GitHub shows that you <strong>control</strong> a repository. It does not prove that you
        wrote the code in it. Repositories are read without executing any code.
      </p>

      {connectionQuery.isLoading && <p style={noteStyle}>Checking GitHub connection…</p>}
      {connectionQuery.isError && (
        <p role="alert" style={errorStyle}>
          {getApiErrorMessage(connectionQuery.error, 'Could not check the GitHub connection.')}
        </p>
      )}

      {connection && connection.configured === false && (
        <p style={noteStyle}>
          GitHub Connect is not set up on this server, so repositories cannot be added as evidence. Your
          resume alone is used for verification.
        </p>
      )}

      {connection && connection.configured && !isConnected && (
        <div>
          {connection.needsReconnect && (
            <p role="alert" style={errorStyle}>
              Your GitHub connection expired or was revoked. Please connect again.
            </p>
          )}
          <button type="button" className="button primary-button" onClick={handleConnect} disabled={isConnecting}>
            {isConnecting ? 'Redirecting to GitHub…' : connection.needsReconnect ? 'Reconnect GitHub' : 'Connect GitHub'}
          </button>
          <p style={noteStyle}>
            You will authorize JobFitAI on GitHub. It requests no repository permissions: it only learns who you are
            and which public repositories you own.
          </p>
        </div>
      )}

      {isConnected && (
        <div>
          <p style={{ margin: '0 0 0.5rem 0' }}>
            Connected as <strong>@{connection.login}</strong>{' '}
            <button type="button" className="button secondary-button" onClick={handleDisconnect}>
              Disconnect
            </button>
          </p>

          {reposQuery.isLoading && <p style={noteStyle}>Loading your public repositories…</p>}
          {reposError && (
            <p role="alert" style={errorStyle}>
              {reposError}
            </p>
          )}

          {reposQuery.isSuccess && repos.length === 0 && (
            <p style={noteStyle}>No public repositories were found on this account.</p>
          )}

          {repos.length > 0 && (
            <ul style={{ listStyle: 'none', padding: 0, margin: '0.5rem 0' }} aria-label="Your public repositories">
              {repos.map((repo) => (
                <li key={repo.repoId} style={{ margin: '0.4rem 0', opacity: repo.selectable ? 1 : 0.65 }}>
                  <label style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start' }}>
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
                      <strong>{repo.fullName}</strong>{' '}
                      <small>
                        Public
                        {repo.control?.verified ? ' · you own this repository' : ''}
                        {repo.isFork ? ' · fork' : ''}
                        {repo.isArchived ? ' · archived' : ''}
                      </small>
                      {repo.description && <div style={noteStyle}>{repo.description}</div>}
                      {!repo.selectable && repo.unsupportedMessage && (
                        <div style={{ ...noteStyle, color: '#e0a458' }}>{repo.unsupportedMessage}</div>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}

          <p style={noteStyle}>
            Private repositories are not supported in this version and are not listed. Organization and
            collaborator repositories are not supported yet.
          </p>

          <button
            type="button"
            className="button primary-button"
            onClick={handleAnalyze}
            disabled={selectedRepoId === null || isStarting || isJobActive}
          >
            {isStarting || isJobActive ? 'Analyzing…' : 'Analyze selected repository'}
          </button>
        </div>
      )}

      {isJobActive && (
        <p role="status" style={noteStyle}>
          {activeJob.job?.status === 'queued' ? 'Queued…' : 'Scanning repository…'}
          {activeJob.totalCount > 0 ? ` ${activeJob.doneCount} / ${activeJob.totalCount} files` : ''}
        </p>
      )}

      {actionError && (
        <p role="alert" style={errorStyle}>
          {actionError}
        </p>
      )}

      {completed && (
        <p role="status" style={{ margin: '0.75rem 0', color: '#34d399' }}>
          ✓ Linked {completed.analysis?.repositoryFullName}.{' '}
          {completed.control?.verified
            ? `Ownership verified: this repository belongs to your GitHub account (@${completed.control.githubLogin}). It counts toward verification. Authorship of the code is not verified.`
            : 'Ownership was not verified, so this repository does not count toward verification.'}
        </p>
      )}

    </section>
  );
}
