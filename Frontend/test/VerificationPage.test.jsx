import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../src/features/verification/services/verification.api', () => ({
  getVerificationRun: vi.fn(),
  getGroundedDraft: vi.fn(),
  getLatestDraft: vi.fn(),
  getReportGithubLinks: vi.fn(),
  setGithubLinkProject: vi.fn(),
  createDraftForReport: vi.fn(),
  startVerificationJob: vi.fn(),
  getJobById: vi.fn(),
  getPrintDraftUrl: vi.fn(() => '/print'),
  downloadGroundedPdf: vi.fn(),
  updateClaimOverride: vi.fn(),
}));
vi.mock('../src/features/interview/services/interview.api', () => ({
  getInterviewReportById: vi.fn(),
}));
vi.mock('../src/features/verification/components/GithubConnectPanel', () => ({
  default: () => <div data-testid='github-panel' />,
}));
vi.mock('../src/features/verification/components/ProjectRankingPanel', () => ({
  default: () => <div data-testid='ranking-panel' />,
}));

import {
  getVerificationRun,
  getLatestDraft,
  getReportGithubLinks,
  setGithubLinkProject,
  createDraftForReport,
  startVerificationJob,
} from '../src/features/verification/services/verification.api';
import { getInterviewReportById } from '../src/features/interview/services/interview.api';
import VerificationPage from '../src/features/verification/pages/VerificationPage';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/interview/r1/verify']}>
        <Routes>
          <Route path='/interview/:interviewId/verify' element={<VerificationPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const notFound = () => Object.assign(new Error('nf'), { response: { status: 404 } });

describe('VerificationPage step order (Phase 0)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getVerificationRun.mockRejectedValue(notFound());
    getReportGithubLinks.mockResolvedValue({ links: [], draftProjects: [], hasDraft: false });
    getInterviewReportById.mockResolvedValue({ interviewReport: { _id: 'r1', resume: 'Some resume text here' } });
  });

  it('keeps Run Verification disabled until a draft exists, and offers to generate the draft first', async () => {
    getLatestDraft.mockResolvedValue(null);
    renderPage();

    const verifyBtn = await screen.findByRole('button', { name: /2\. run verification/i });
    expect(verifyBtn.disabled).toBe(true);
    expect(await screen.findByText('No Draft Yet')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /1\. generate resume draft/i }).length).toBeGreaterThan(0);
    expect(startVerificationJob).not.toHaveBeenCalled();
  });

  it('enables Run Verification once a draft exists', async () => {
    getLatestDraft.mockResolvedValue({ experience: [] });
    renderPage();

    await screen.findByText('Ready to Verify');
    const verifyBtn = screen.getAllByRole('button', { name: /2\. run verification/i })[0];
    expect(verifyBtn.disabled).toBe(false);
  });

  it('generating a draft unlocks verification', async () => {
    getLatestDraft.mockResolvedValueOnce(null).mockResolvedValue({ experience: [] });
    createDraftForReport.mockResolvedValue({ draft: {} });
    renderPage();

    const gen = (await screen.findAllByRole('button', { name: /1\. generate resume draft/i }))[0];
    fireEvent.click(gen);

    await waitFor(() => expect(createDraftForReport).toHaveBeenCalledWith('r1'));
    await screen.findByText('Ready to Verify');
    expect(screen.getAllByRole('button', { name: /2\. run verification/i })[0].disabled).toBe(false);
  });

  it('does not block the user when the draft lookup itself fails', async () => {
    getLatestDraft.mockRejectedValue(Object.assign(new Error('boom'), { response: { status: 500 } }));
    renderPage();

    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /2\. run verification/i })[0].disabled).toBe(false)
    );
  });

  it('states which resume the draft is built from', async () => {
    getLatestDraft.mockResolvedValue(null);
    renderPage();
    expect((await screen.findByTestId('resume-source-notice')).textContent).toMatch(
      /resume you uploaded for this plan.*do not need to upload it again/i
    );
  });

  it('says so when the plan has no resume, only a self-description', async () => {
    getLatestDraft.mockResolvedValue(null);
    getInterviewReportById.mockResolvedValue({
      interviewReport: { _id: 'r1', resume: '', selfDescription: 'I build APIs' },
    });
    renderPage();
    expect((await screen.findByTestId('resume-source-notice')).textContent).toMatch(/self-description only/i);
  });

  it('shows the three steps', async () => {
    getLatestDraft.mockResolvedValue(null);
    renderPage();
    const steps = await screen.findByTestId('verification-steps');
    expect(steps.textContent).toMatch(/1\. generate draft/i);
    expect(steps.textContent).toMatch(/2\. verify claims/i);
    expect(steps.textContent).toMatch(/3\. export/i);
  });
});

describe('VerificationPage linked repositories (Phase 1)', () => {
  const links = {
    hasDraft: true,
    draftProjects: ['Meri Sakhi', 'Backend Ledger'],
    links: [
      { analysisId: 'a1', repositoryFullName: 'me/meri-sakhi', verified: true, explicitProjectName: null, matchedProject: 'Meri Sakhi', matchSource: 'name' },
      { analysisId: 'a2', repositoryFullName: 'me/anvaya-agent', verified: true, explicitProjectName: null, matchedProject: null, matchSource: 'none' },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getVerificationRun.mockRejectedValue(notFound());
    getLatestDraft.mockResolvedValue({ projects: [] });
    getInterviewReportById.mockResolvedValue({ interviewReport: { _id: 'r1', resume: 'Some resume text here' } });
    getReportGithubLinks.mockResolvedValue(links);
  });

  it('shows the linked repositories from the server with the project each one is used for', async () => {
    renderPage();
    const panel = await screen.findByTestId('github-project-links');
    expect(panel.textContent).toMatch(/me\/meri-sakhi/);
    expect(panel.textContent).toMatch(/Used as evidence for: Meri Sakhi/);
    expect(panel.textContent).toMatch(/me\/anvaya-agent/);
    expect(panel.textContent).toMatch(/Not matched to a project in your draft yet/);
  });

  it('lets the user choose which draft project a repository belongs to', async () => {
    setGithubLinkProject.mockResolvedValue({ analysisId: 'a2', projectName: 'Backend Ledger' });
    renderPage();

    const select = await screen.findByLabelText('Belongs to project', { selector: '#project-for-a2' });
    expect([...select.options].map((o) => o.value)).toEqual(['', 'Meri Sakhi', 'Backend Ledger']);
    fireEvent.change(select, { target: { value: 'Backend Ledger' } });

    await waitFor(() => expect(setGithubLinkProject).toHaveBeenCalledWith('r1', 'a2', 'Backend Ledger'));
  });

  it('returns to automatic matching when the choice is cleared', async () => {
    setGithubLinkProject.mockResolvedValue({ analysisId: 'a1', projectName: null });
    getReportGithubLinks.mockResolvedValue({
      ...links,
      links: [{ ...links.links[0], explicitProjectName: 'Backend Ledger', matchedProject: 'Backend Ledger', matchSource: 'user' }],
    });
    renderPage();

    const select = await screen.findByLabelText('Belongs to project', { selector: '#project-for-a1' });
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(setGithubLinkProject).toHaveBeenCalledWith('r1', 'a1', null));
  });

  it('starts verification with the repositories saved on the server, so a page reload does not lose them', async () => {
    startVerificationJob.mockResolvedValue({ jobId: 'j1' });
    getReportGithubLinks.mockResolvedValue({
      ...links,
      links: [...links.links, { analysisId: 'legacy', repositoryFullName: 'x/old', verified: false, matchedProject: null, matchSource: 'none' }],
    });
    renderPage();

    await screen.findByTestId('github-project-links');
    await screen.findByText('Ready to Verify');
    fireEvent.click(screen.getAllByRole('button', { name: /2\. run verification/i })[0]);

    await waitFor(() =>
      expect(startVerificationJob).toHaveBeenCalledWith('r1', { githubAnalysisIds: ['a1', 'a2'] }) // unverified legacy link is not sent
    );
  });

  it('says so when the draft has not been generated yet, instead of offering project choices', async () => {
    getLatestDraft.mockResolvedValue(null);
    getReportGithubLinks.mockResolvedValue({ ...links, hasDraft: false, draftProjects: [] });
    renderPage();

    expect(await screen.findByTestId('links-need-draft')).toBeTruthy();
    expect(screen.queryByLabelText('Belongs to project', { selector: '#project-for-a1' })).toBeNull();
  });

  it('shows a notice after verification when a repository was not matched to any project', async () => {
    getVerificationRun.mockResolvedValue({
      run: { _id: 'run1', config: { githubEvidence: { unmatchedAnalysisIds: ['a2'], usedAnalysisIds: ['a1'] } } },
      claims: [],
    });
    renderPage();
    const notice = await screen.findByTestId('unmatched-github-notice');
    expect(notice.textContent).toMatch(/did not match any project in the draft/i);
  });
});
