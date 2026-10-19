import React, { useState } from 'react';
import { startGitHubAnalysis, getGitHubAnalysis } from '../services/verification.api';
import { useJob } from '../hooks/useJob';

export default function GithubLinkForm({ reportId, onAnalysisComplete }) {
  const [repoUrl, setRepoUrl] = useState('');
  const [inlineError, setInlineError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeJobId, setActiveJobId] = useState(null);
  const [completedAnalysis, setCompletedAnalysis] = useState(null);

  const activeJob = useJob(activeJobId, {
    onDone: async (job) => {
      try {
        if (job.resultRef) {
          const data = await getGitHubAnalysis(job.resultRef);
          setCompletedAnalysis(data.analysis);
          if (typeof onAnalysisComplete === 'function') {
            onAnalysisComplete(data.analysis);
          }
        }
      } catch (err) {
        console.error('Failed to load completed analysis:', err);
      }
    },
    onFailed: (failedJob) => {
      setInlineError(failedJob.error?.message || 'GitHub analysis failed');
    },
  });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setInlineError(null);
    setCompletedAnalysis(null);

    const trimmed = repoUrl.trim();
    if (!trimmed) {
      setInlineError('Please enter a GitHub repository URL.');
      return;
    }

    if (!trimmed.startsWith('https://github.com/')) {
      setInlineError('Only public https://github.com/<owner>/<repo> URLs are supported.');
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await startGitHubAnalysis(reportId, trimmed);
      if (res.jobId) {
        setActiveJobId(res.jobId);
      }
    } catch (err) {
      const msg =
        err.response?.data?.error?.message ||
        err.response?.data?.message ||
        err.message ||
        'Failed to start repository analysis';
      setInlineError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const isJobActive = activeJob && (activeJob.status === 'queued' || activeJob.status === 'running');

  return (
    <div className="github-link-form" role="region" aria-label="GitHub Repository Evidence">
      <div className="github-link-form__header">
        <h3 className="github-link-form__title">Link GitHub Repository Evidence</h3>
        <p className="github-link-form__desc">
          Provide a public GitHub repository to verify technologies, frameworks, and architecture patterns against source code and manifests without executing any code.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="github-link-form__form">
        <div className="github-link-form__row">
          <input
            type="url"
            value={repoUrl}
            onChange={(e) => {
              setRepoUrl(e.target.value);
              if (inlineError) setInlineError(null);
            }}
            placeholder="https://github.com/owner/repository"
            className="github-link-form__input"
            disabled={isSubmitting || isJobActive}
            required
          />
          <button
            type="submit"
            className="btn btn-primary github-link-form__btn"
            disabled={isSubmitting || isJobActive}
          >
            {isSubmitting || isJobActive ? 'Analyzing...' : 'Link & Analyze'}
          </button>
        </div>

        {inlineError && (
          <div className="github-link-form__error" role="alert">
            <span className="github-link-form__error-icon">⚠️</span>
            <span>{inlineError}</span>
          </div>
        )}

        {isJobActive && (
          <div className="github-link-form__progress">
            <div className="github-link-form__progress-label">
              <span>Status: {activeJob.status === 'queued' ? 'Queued' : 'Scanning repository tree & AST...'}</span>
              {activeJob.progress && activeJob.progress.total > 0 && (
                <span>
                  {activeJob.progress.done} / {activeJob.progress.total} files
                </span>
              )}
            </div>
            <div className="github-link-form__progress-bar">
              <div
                className="github-link-form__progress-fill"
                style={{
                  width:
                    activeJob.progress?.total > 0
                      ? `${Math.min(100, Math.round((activeJob.progress.done / activeJob.progress.total) * 100))}%`
                      : '30%',
                }}
              />
            </div>
          </div>
        )}

        {completedAnalysis && (
          <div className="github-link-form__success" role="status">
            <span className="github-link-form__success-icon">✓</span>
            <div>
              <strong>Linked: {completedAnalysis.repositoryFullName}</strong>
              <div className="github-link-form__success-meta">
                <span>Commit: {completedAnalysis.commitSha?.slice(0, 7)}</span>
                <span>•</span>
                <span>{completedAnalysis.evidenceItems?.length || 0} evidence items found</span>
                <span>•</span>
                <span>{completedAnalysis.dependencies?.length || 0} dependencies</span>
              </div>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
