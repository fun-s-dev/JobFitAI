import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../src/features/verification/services/verification.api', () => ({
  getVerificationRun: vi.fn(),
  getGroundedDraft: vi.fn(),
  getLatestDraft: vi.fn(),
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

import {
  getVerificationRun,
  getLatestDraft,
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
