import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../src/features/verification/services/verification.api', () => ({
  getGithubConnection: vi.fn(),
  getRepoRanking: vi.fn(),
  startRepoRanking: vi.fn(),
  confirmRepoSelection: vi.fn(),
  getJobById: vi.fn(),
}));

import {
  getGithubConnection,
  getRepoRanking,
  startRepoRanking,
  confirmRepoSelection,
  getJobById,
} from '../src/features/verification/services/verification.api';
import ProjectRankingPanel from '../src/features/verification/components/ProjectRankingPanel';

const ranking = {
  rankedAt: '2026-11-04T10:00:00Z',
  selectedRepoIds: [1, 2],
  selectionConfirmedAt: null,
  requirements: [
    { text: 'Build REST APIs with Node.js', importance: 'must', keywords: ['Node.js'] },
    { text: 'Experience with RAG', importance: 'nice', keywords: ['RAG'] },
  ],
  repos: [
    {
      repoId: 1, fullName: 'me/node-api', status: 'ranked', rank: 1, score: 0.61, level: 'strong', description: 'A REST API',
      matched: [{ requirement: 'Build REST APIs with Node.js', importance: 'must', snippet: 'REST API built with Node.js and Express', source: 'readme', cosine: 0.9 }],
    },
    {
      repoId: 2, fullName: 'me/rag-bot', status: 'ranked', rank: 2, score: 0.2, level: 'partial', description: null,
      matched: [{ requirement: 'Experience with RAG', importance: 'nice', snippet: 'A RAG assistant', source: 'readme', cosine: 0.8 }],
    },
    { repoId: 3, fullName: 'me/react-todo', status: 'ranked', rank: 3, score: 0, level: 'weak', description: null, matched: [] },
    { repoId: 4, fullName: 'me/no-readme', status: 'skipped_no_readme', skipReason: 'me/no-readme has no README, so it was skipped.', matched: [] },
    { repoId: 5, fullName: 'me/broken', status: 'skipped_error', skipReason: 'me/broken could not be analysed (rate limit), so it was skipped.', matched: [] },
  ],
};

function renderPanel(props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProjectRankingPanel reportId='r1' {...props} />
    </QueryClientProvider>
  );
}

describe('ProjectRankingPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getGithubConnection.mockResolvedValue({ configured: true, connected: true, login: 'me' });
    getRepoRanking.mockResolvedValue({ ranking: null, topN: 2 });
  });

  it('renders nothing until GitHub is connected', async () => {
    getGithubConnection.mockResolvedValue({ configured: true, connected: false });
    renderPanel();
    await waitFor(() => expect(getGithubConnection).toHaveBeenCalled());
    expect(screen.queryByTestId('project-ranking')).toBeNull();
    expect(getRepoRanking).not.toHaveBeenCalled();
  });

  it('offers to find the best projects, and explains that only repositories with a README count', async () => {
    renderPanel();
    expect(await screen.findByRole('button', { name: /find my best projects for this job/i })).toBeTruthy();
    expect(screen.getByTestId('project-ranking').textContent).toMatch(/only repositories with a readme are considered/i);
  });

  it('starts the job, shows progress and loads the ranking when it finishes', async () => {
    startRepoRanking.mockResolvedValue({ jobId: 'j1' });
    getJobById
      .mockResolvedValueOnce({ job: { status: 'running', progress: { done: 2, total: 5 } } })
      .mockResolvedValue({ job: { status: 'done', progress: { done: 5, total: 5 } } });
    getRepoRanking.mockResolvedValueOnce({ ranking: null, topN: 2 }).mockResolvedValue({ ranking, topN: 2 });

    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /find my best projects/i }));

    expect(await screen.findByText(/analysed 2 of 5 repositories/i)).toBeTruthy();
    expect(await screen.findByTestId('ranked-1', {}, { timeout: 6000 })).toBeTruthy();
    expect(startRepoRanking).toHaveBeenCalledWith('r1');
  }, 15000);

  describe('with a ranking', () => {
    beforeEach(() => {
      getRepoRanking.mockResolvedValue({ ranking, topN: 2 });
    });

    it('lists ranked repositories in order with the matched passage as the reason', async () => {
      renderPanel();
      const first = await screen.findByTestId('ranked-1');
      expect(first.textContent).toMatch(/#1 me\/node-api/);
      expect(first.textContent).toMatch(/Strong match/);
      expect(screen.getByTestId('level-2').textContent).toBe('Partial match');
      expect(screen.getByTestId('level-3').textContent).toBe('Weak match');
      expect(first.textContent).toMatch(/Build REST APIs with Node\.js/);
      expect(first.textContent).toMatch(/REST API built with Node\.js and Express/);

      expect(screen.getByTestId('ranked-2').textContent).toMatch(/#2 me\/rag-bot/);
      expect(screen.getByTestId('ranked-3').textContent).toMatch(/No passage in this repository matched the job closely/);
    });

    it('says clearly which repositories were skipped and why (no README)', async () => {
      renderPanel();
      const skipped = await screen.findByTestId('skipped-repos');
      expect(skipped.textContent).toMatch(/me\/no-readme has no README, so it was skipped\./);
      expect(skipped.textContent).toMatch(/me\/broken could not be analysed/);
      expect(screen.queryByTestId('ranked-4')).toBeNull();
    });

    it('pre-selects the top repositories and caps the selection at the limit', async () => {
      renderPanel();
      const box = (name) => screen.findByRole('checkbox', { name: `Use ${name}` });
      expect((await box('me/node-api')).checked).toBe(true);
      expect((await box('me/rag-bot')).checked).toBe(true);
      const third = await box('me/react-todo');
      expect(third.checked).toBe(false);
      expect(third.disabled).toBe(true); // limit of 2 reached

      fireEvent.click(await box('me/rag-bot')); // deselect one
      await waitFor(() => expect(third.disabled).toBe(false));
      fireEvent.click(third);
      expect(third.checked).toBe(true);
    });

    it('confirms the selection: sends the chosen ids, refreshes the linked repositories and reports it', async () => {
      confirmRepoSelection.mockResolvedValue({ selectedRepoIds: [1, 3] });
      const onSelectionConfirmed = vi.fn();
      renderPanel({ onSelectionConfirmed });

      fireEvent.click(await screen.findByRole('checkbox', { name: 'Use me/rag-bot' }));
      fireEvent.click(await screen.findByRole('checkbox', { name: 'Use me/react-todo' }));
      fireEvent.click(screen.getByRole('button', { name: /use 2 selected projects/i }));

      await waitFor(() => expect(confirmRepoSelection).toHaveBeenCalledWith('r1', [1, 3]));
      expect((await screen.findByTestId('ranking-confirmed')).textContent).toMatch(/Using 2 projects: me\/node-api, me\/react-todo/);
      expect(onSelectionConfirmed).toHaveBeenCalled();
    });

    it('shows the server’s reason when the selection is refused', async () => {
      confirmRepoSelection.mockRejectedValue({
        response: { status: 422, data: { message: 'This repository is not owned by your connected GitHub account.' } },
      });
      renderPanel();
      fireEvent.click(await screen.findByRole('button', { name: /use 2 selected projects/i }));
      expect(await screen.findByText(/not owned by your connected github account/i)).toBeTruthy();
      expect(screen.queryByTestId('ranking-confirmed')).toBeNull();
    });

    it('cannot confirm an empty selection', async () => {
      renderPanel();
      fireEvent.click(await screen.findByRole('checkbox', { name: 'Use me/node-api' }));
      fireEvent.click(await screen.findByRole('checkbox', { name: 'Use me/rag-bot' }));
      const btn = screen.getByRole('button', { name: /use 0 selected projects/i });
      expect(btn.disabled).toBe(true);
    });

    it('lists what the job asks for', async () => {
      renderPanel();
      const summary = await screen.findByText(/what this job asks for \(2\)/i);
      expect(within(summary.closest('details')).getByText(/Build REST APIs with Node\.js/)).toBeTruthy();
    });

    it('offers to rank again', async () => {
      renderPanel();
      expect(await screen.findByRole('button', { name: /rank again/i })).toBeTruthy();
    });
  });

  it('shows why a ranking could not start (for example daily limit reached)', async () => {
    startRepoRanking.mockRejectedValue({
      response: { status: 429, data: { message: 'Daily project ranking limit reached (5 per day). Reset at midnight Pacific.' } },
    });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /find my best projects/i }));
    expect(await screen.findByText(/daily project ranking limit reached/i)).toBeTruthy();
  });

  it('shows the failure of the ranking job', async () => {
    startRepoRanking.mockResolvedValue({ jobId: 'j1' });
    getJobById.mockResolvedValue({
      job: { status: 'failed', progress: { done: 0, total: 0 }, error: { code: 'NO_ELIGIBLE_REPOS', message: 'No eligible repositories were found.' } },
    });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /find my best projects/i }));
    expect(await screen.findByText(/no eligible repositories were found/i, {}, { timeout: 6000 })).toBeTruthy();
  }, 15000);

  it('says when none of the repositories could be ranked', async () => {
    getRepoRanking.mockResolvedValue({
      ranking: { ...ranking, repos: [ranking.repos[3]], selectedRepoIds: [] },
      topN: 2,
    });
    renderPanel();
    expect(await screen.findByText(/none of your repositories could be ranked/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /selected project/i })).toBeNull();
  });
});
