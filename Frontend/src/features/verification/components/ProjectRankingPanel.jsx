import React, { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getGithubConnection,
  getRepoRanking,
  startRepoRanking,
  confirmRepoSelection,
} from '../services/verification.api';
import { useJob } from '../hooks/useJob';
import { getApiErrorMessage } from '../../../services/apiError';

// The server bands the score (raw scores are small on this embedding model, so a percentage would mislead)
const LEVEL_LABEL = { strong: 'Strong match', partial: 'Partial match', weak: 'Weak match' };

/**
 * "Find my best projects for this job": analyses the user's repositories, ranks them against the job
 * description and lets the user confirm or swap the top ones.
 *
 * The reasons shown are the actual README/description passages that matched each job requirement, not
 * a generated explanation. Repositories without a README are listed as skipped, with the reason.
 *
 * @param {object} props
 * @param {string} props.reportId
 * @param {() => void} [props.onSelectionConfirmed]
 */
export default function ProjectRankingPanel({ reportId, onSelectionConfirmed }) {
  const queryClient = useQueryClient();
  const [activeJobId, setActiveJobId] = useState(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [selected, setSelected] = useState([]);
  const [error, setError] = useState(null);
  const [confirmedNotice, setConfirmedNotice] = useState(null);

  const connectionQuery = useQuery({ queryKey: ['githubConnection'], queryFn: getGithubConnection, retry: false });
  const isConnected = Boolean(connectionQuery.data?.connected);

  const rankingQuery = useQuery({
    queryKey: ['repoRanking', reportId],
    queryFn: () => getRepoRanking(reportId),
    enabled: Boolean(reportId) && isConnected,
    staleTime: 15000,
  });
  const ranking = rankingQuery.data?.ranking || null;
  const topN = rankingQuery.data?.topN || 4;

  const job = useJob(activeJobId, {
    onDone: () => {
      queryClient.invalidateQueries({ queryKey: ['repoRanking', reportId] });
    },
    onFailed: (failed) => {
      setError(failed.error?.message || 'Ranking your repositories failed.');
    },
  });
  const isRunning = job.isRunning || isStarting;

  // Start from the server's selection (the top repositories by default) whenever the ranking changes
  const rankedKey = ranking ? `${ranking.rankedAt}:${(ranking.selectedRepoIds || []).join(',')}` : '';
  useEffect(() => {
    setSelected(ranking ? [...(ranking.selectedRepoIds || [])] : []);
    setConfirmedNotice(null);
  }, [rankedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isConnected) return null;

  const handleStart = async () => {
    setError(null);
    setConfirmedNotice(null);
    setIsStarting(true);
    try {
      const res = await startRepoRanking(reportId);
      if (res.jobId) setActiveJobId(res.jobId);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Could not start ranking your repositories.'));
    } finally {
      setIsStarting(false);
    }
  };

  const toggle = (repoId) => {
    setConfirmedNotice(null);
    setSelected((prev) => {
      if (prev.includes(repoId)) return prev.filter((id) => id !== repoId);
      if (prev.length >= topN) return prev;
      return [...prev, repoId];
    });
  };

  const handleConfirm = async () => {
    setError(null);
    setIsConfirming(true);
    try {
      await confirmRepoSelection(reportId, selected);
      const names = (ranking?.repos || []).filter((r) => selected.includes(r.repoId)).map((r) => r.fullName);
      setConfirmedNotice(`Using ${names.length} project${names.length === 1 ? '' : 's'}: ${names.join(', ')}`);
      queryClient.invalidateQueries({ queryKey: ['repoRanking', reportId] });
      queryClient.invalidateQueries({ queryKey: ['githubLinks', reportId] });
      if (typeof onSelectionConfirmed === 'function') onSelectionConfirmed();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Could not save your selection.'));
    } finally {
      setIsConfirming(false);
    }
  };

  const ranked = (ranking?.repos || []).filter((r) => r.status === 'ranked');
  const skipped = (ranking?.repos || []).filter((r) => r.status !== 'ranked');

  return (
    <section aria-label='Best projects for this job' data-testid='project-ranking' className='ranking'>
      <div className='vp-panel__head'>
        <div>
          <h3 className='vp-panel__sub'>Best projects for this job</h3>
          <p className='vp-panel__desc'>
            Your public repositories are compared with what this job asks for. Only repositories with a README are
            considered. Choose up to {topN} to use as your projects.
          </p>
        </div>
        <button type='button' className='vp-btn vp-btn--primary' onClick={handleStart} disabled={isRunning}>
          {isRunning && <span className='vp-spinner' aria-hidden='true' />}
          {isRunning ? 'Analysing your repositories…' : ranking ? 'Rank again' : 'Find my best projects for this job'}
        </button>
      </div>

      {job.isRunning && (
        <div className='vp-alert vp-alert--info' role='status'>
          <span className='vp-alert__icon' aria-hidden='true'>⏳</span>
          <span className='vp-alert__body'>
            {job.totalCount > 0 && job.doneCount >= job.totalCount
              ? 'Comparing your repositories with the job. On the free Gemini tier this can take a few minutes; keep this page open.'
              : job.totalCount > 0
              ? `Analysed ${job.doneCount} of ${job.totalCount} repositories…`
              : 'Starting…'}
          </span>
        </div>
      )}

      {error && (
        <div className='vp-alert vp-alert--error' role='alert'>
          <span className='vp-alert__icon' aria-hidden='true'>⚠</span>
          <span className='vp-alert__body'>{error}</span>
        </div>
      )}

      {ranking && (
        <>
          <details className='vp-details'>
            <summary>What this job asks for ({ranking.requirements.length})</summary>
            <div className='vp-details__body'>
              <div className='req-chips'>
                {ranking.requirements.map((r) => (
                  <span key={r.text} className={`req-chip${r.importance === 'must' ? ' req-chip--must' : ''}`}>
                    {r.text} <small>({r.importance === 'must' ? 'required' : 'nice to have'})</small>
                  </span>
                ))}
              </div>
            </div>
          </details>

          {ranked.length === 0 && (
            <p className='vp-panel__desc'>None of your repositories could be ranked. See the skipped list below.</p>
          )}

          <ol className='rank-list' aria-label='Ranked repositories'>
            {ranked.map((repo) => {
              const checked = selected.includes(repo.repoId);
              const limitReached = !checked && selected.length >= topN;
              return (
                <li
                  key={repo.repoId}
                  className={`rank-card${checked ? ' rank-card--selected' : ''}`}
                  data-testid={`ranked-${repo.repoId}`}
                >
                  <label className='rank-card__top'>
                    <span className='rank-card__rank' aria-hidden='true'>#{repo.rank}</span>
                    <span className='rank-card__main'>
                      <span className='rank-card__name'>
                        <span className='sr-only'>#{repo.rank} </span>
                        {repo.fullName}
                      </span>
                      {repo.description && <span className='rank-card__desc'>{repo.description}</span>}
                    </span>
                    <span
                      className={`match-pill match-pill--${repo.level || 'weak'}`}
                      data-testid={`level-${repo.repoId}`}
                    >
                      {LEVEL_LABEL[repo.level] || 'Match'}
                    </span>
                    <input
                      type='checkbox'
                      className='vp-check'
                      checked={checked}
                      disabled={limitReached || isConfirming}
                      onChange={() => toggle(repo.repoId)}
                      aria-label={`Use ${repo.fullName}`}
                    />
                  </label>
                  {repo.matched.length > 0 ? (
                    <ul className='rank-card__reasons'>
                      {repo.matched.map((m) => (
                        <li key={m.requirement} className='rank-card__reason'>
                          <span className='rank-card__reason-req'>{m.requirement}</span>“{m.snippet}”
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className='rank-card__none'>No passage in this repository matched the job closely.</p>
                  )}
                </li>
              );
            })}
          </ol>

          {ranked.length > 0 && (
            <div>
              <button
                type='button'
                className='vp-btn vp-btn--primary'
                onClick={handleConfirm}
                disabled={selected.length === 0 || isConfirming}
              >
                {isConfirming ? 'Saving…' : `Use ${selected.length} selected project${selected.length === 1 ? '' : 's'}`}
              </button>
            </div>
          )}

          {confirmedNotice && (
            <div className='vp-alert vp-alert--success' role='status' data-testid='ranking-confirmed'>
              <span className='vp-alert__icon' aria-hidden='true'>✓</span>
              <span className='vp-alert__body'>{confirmedNotice}</span>
            </div>
          )}

          {skipped.length > 0 && (
            <div data-testid='skipped-repos'>
              <h4 className='vp-panel__sub' style={{ marginBottom: '0.5rem' }}>Skipped</h4>
              <ul className='skip-list'>
                {skipped.map((repo) => (
                  <li key={repo.repoId}>
                    <span aria-hidden='true'>⚠</span>
                    <span>{repo.skipReason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
