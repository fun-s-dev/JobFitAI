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

const noteStyle = { fontSize: '0.85rem', color: '#9aa4b2', margin: '0.5rem 0' };
const errorStyle = { color: '#ff6b6b', fontSize: '0.9rem', margin: '0.5rem 0' };
const okStyle = { color: '#34d399', margin: '0.75rem 0' };

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
    <section aria-label='Best projects for this job' data-testid='project-ranking' style={{ margin: '1.5rem 0' }}>
      <h3 className='github-link-form__title'>Best projects for this job</h3>
      <p style={noteStyle}>
        Your public repositories are compared with what this job asks for. Only repositories with a README are
        considered. Choose up to {topN} to use as your projects.
      </p>

      <button type='button' className='button primary-button' onClick={handleStart} disabled={isRunning}>
        {isRunning ? 'Analysing your repositories…' : ranking ? 'Rank again' : 'Find my best projects for this job'}
      </button>

      {job.isRunning && (
        <p role='status' style={noteStyle}>
          {job.totalCount > 0 && job.doneCount >= job.totalCount
            ? 'Comparing your repositories with the job. On the free Gemini tier this can take a few minutes; keep this page open.'
            : job.totalCount > 0
            ? `Analysed ${job.doneCount} of ${job.totalCount} repositories…`
            : 'Starting…'}
        </p>
      )}

      {error && (
        <p role='alert' style={errorStyle}>
          {error}
        </p>
      )}

      {ranking && (
        <div style={{ marginTop: '1rem' }}>
          <details>
            <summary>What this job asks for ({ranking.requirements.length})</summary>
            <ul>
              {ranking.requirements.map((r) => (
                <li key={r.text}>
                  {r.text} <small>({r.importance === 'must' ? 'required' : 'nice to have'})</small>
                </li>
              ))}
            </ul>
          </details>

          {ranked.length === 0 && (
            <p style={noteStyle}>None of your repositories could be ranked. See the skipped list below.</p>
          )}

          <ol style={{ listStyle: 'none', padding: 0 }} aria-label='Ranked repositories'>
            {ranked.map((repo) => {
              const checked = selected.includes(repo.repoId);
              const limitReached = !checked && selected.length >= topN;
              return (
                <li key={repo.repoId} style={{ margin: '0.9rem 0' }} data-testid={`ranked-${repo.repoId}`}>
                  <label style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start' }}>
                    <input
                      type='checkbox'
                      checked={checked}
                      disabled={limitReached || isConfirming}
                      onChange={() => toggle(repo.repoId)}
                      aria-label={`Use ${repo.fullName}`}
                    />
                    <span>
                      <strong>
                        #{repo.rank} {repo.fullName}
                      </strong>{' '}
                      <small data-testid={`level-${repo.repoId}`}>{LEVEL_LABEL[repo.level] || 'Match'}</small>
                      {repo.description && <div style={noteStyle}>{repo.description}</div>}
                    </span>
                  </label>
                  {repo.matched.length > 0 ? (
                    <ul style={{ margin: '0.25rem 0 0 2rem', fontSize: '0.85rem' }}>
                      {repo.matched.map((m) => (
                        <li key={m.requirement}>
                          <span style={{ color: '#9aa4b2' }}>{m.requirement}:</span> “{m.snippet}”
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p style={{ ...noteStyle, marginLeft: '2rem' }}>No passage in this repository matched the job closely.</p>
                  )}
                </li>
              );
            })}
          </ol>

          {ranked.length > 0 && (
            <button
              type='button'
              className='button primary-button'
              onClick={handleConfirm}
              disabled={selected.length === 0 || isConfirming}
            >
              {isConfirming ? 'Saving…' : `Use ${selected.length} selected project${selected.length === 1 ? '' : 's'}`}
            </button>
          )}

          {confirmedNotice && (
            <p role='status' style={okStyle} data-testid='ranking-confirmed'>
              ✓ {confirmedNotice}
            </p>
          )}

          {skipped.length > 0 && (
            <div style={{ marginTop: '1rem' }} data-testid='skipped-repos'>
              <h4 style={{ margin: '0 0 0.25rem 0' }}>Skipped</h4>
              <ul style={{ margin: 0 }}>
                {skipped.map((repo) => (
                  <li key={repo.repoId} style={{ color: '#e0a458', fontSize: '0.9rem' }}>
                    {repo.skipReason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
