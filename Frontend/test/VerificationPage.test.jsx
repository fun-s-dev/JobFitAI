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
  updateGithubProjectDetails: vi.fn(),
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
  updateGithubProjectDetails,
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

    const verifyBtn = await screen.findByRole('button', { name: /3\. run verification/i });
    expect(verifyBtn.disabled).toBe(true);
    expect(await screen.findByText('No Draft Yet')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /2\. generate resume draft/i }).length).toBeGreaterThan(0);
    expect(startVerificationJob).not.toHaveBeenCalled();
  });

  it('enables Run Verification once a draft exists', async () => {
    getLatestDraft.mockResolvedValue({ experience: [] });
    renderPage();

    await screen.findByText('Ready to Verify');
    const verifyBtn = screen.getAllByRole('button', { name: /3\. run verification/i })[0];
    expect(verifyBtn.disabled).toBe(false);
  });

  it('generating a draft unlocks verification', async () => {
    getLatestDraft.mockResolvedValueOnce(null).mockResolvedValue({ experience: [] });
    createDraftForReport.mockResolvedValue({ draft: {} });
    renderPage();

    const gen = (await screen.findAllByRole('button', { name: /2\. generate resume draft/i }))[0];
    fireEvent.click(gen);

    await waitFor(() => expect(createDraftForReport).toHaveBeenCalledWith('r1'));
    await screen.findByText('Ready to Verify');
    expect(screen.getAllByRole('button', { name: /3\. run verification/i })[0].disabled).toBe(false);
  });

  it('does not block the user when the draft lookup itself fails', async () => {
    getLatestDraft.mockRejectedValue(Object.assign(new Error('boom'), { response: { status: 500 } }));
    renderPage();

    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /3\. run verification/i })[0].disabled).toBe(false)
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

  it('shows the four steps', async () => {
    getLatestDraft.mockResolvedValue(null);
    renderPage();
    const steps = await screen.findByTestId('verification-steps');
    expect(steps.textContent).toMatch(/1\. choose projects/i);
    expect(steps.textContent).toMatch(/2\. generate draft/i);
    expect(steps.textContent).toMatch(/3\. verify claims/i);
    expect(steps.textContent).toMatch(/4\. export/i);
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
    fireEvent.click(screen.getAllByRole('button', { name: /3\. run verification/i })[0]);

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

describe('VerificationPage GitHub projects (Phase 2 step B)', () => {
  const projectLink = (overrides = {}) => ({
    analysisId: 'g1',
    repositoryFullName: 'me/Banking-System-backend',
    verified: true,
    explicitProjectName: null,
    matchedProject: 'Banking System Backend',
    matchSource: 'name',
    selected: true,
    displayName: null,
    defaultName: 'Banking System Backend',
    authorshipConfirmed: false,
    ...overrides,
  });
  const linksWith = (...links) => ({ hasDraft: true, draftProjects: ['Banking System Backend'], links });

  beforeEach(() => {
    vi.clearAllMocks();
    getVerificationRun.mockRejectedValue(notFound());
    getLatestDraft.mockResolvedValue({ projects: [] });
    getInterviewReportById.mockResolvedValue({ interviewReport: { _id: 'r1', resume: 'Some resume text here' } });
    getReportGithubLinks.mockResolvedValue(linksWith(projectLink()));
  });

  it('shows each selected repository as a GitHub project with its name and a warning that it is not confirmed', async () => {
    renderPage();
    const card = await screen.findByTestId('github-project-g1');
    expect(card.textContent).toMatch(/Banking System Backend/);
    expect(card.textContent).toMatch(/from me\/Banking-System-backend/);
    expect(screen.getByTestId('not-confirmed-g1').textContent).toMatch(/will not appear in your exported resume/);
    expect(screen.getByTestId('github-projects').textContent).toMatch(/written from these repositories/);
    // a selected repository is not offered the "belongs to project" dropdown
    expect(screen.queryByLabelText('Belongs to project')).toBeNull();
  });

  it('confirming "I built this project" is sent to the server and refreshes the list', async () => {
    updateGithubProjectDetails.mockResolvedValue({ authorshipConfirmed: true });
    renderPage();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'I built Banking System Backend' }));
    await waitFor(() => expect(updateGithubProjectDetails).toHaveBeenCalledWith('r1', 'g1', { authorshipConfirmed: true }));
    await waitFor(() => expect(getReportGithubLinks.mock.calls.length).toBeGreaterThan(1));
  });

  it('withdrawing the confirmation is sent as false', async () => {
    updateGithubProjectDetails.mockResolvedValue({ authorshipConfirmed: false });
    getReportGithubLinks.mockResolvedValue(linksWith(projectLink({ authorshipConfirmed: true })));
    renderPage();
    const box = await screen.findByRole('checkbox', { name: 'I built Banking System Backend' });
    expect(box.checked).toBe(true);
    expect(screen.queryByTestId('not-confirmed-g1')).toBeNull();
    fireEvent.click(box);
    await waitFor(() => expect(updateGithubProjectDetails).toHaveBeenCalledWith('r1', 'g1', { authorshipConfirmed: false }));
  });

  it('lets the user rename the project, and clear the name to go back to the default', async () => {
    updateGithubProjectDetails.mockResolvedValue({ displayName: 'Backend Ledger' });
    renderPage();
    const input = await screen.findByLabelText('Name on your resume');
    const save = screen.getByRole('button', { name: 'Save name' });
    expect(save.disabled).toBe(true); // nothing changed yet

    fireEvent.change(input, { target: { value: 'Backend Ledger' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(updateGithubProjectDetails).toHaveBeenCalledWith('r1', 'g1', { displayName: 'Backend Ledger' }));
  });

  it('sends null when the name field is emptied', async () => {
    updateGithubProjectDetails.mockResolvedValue({ displayName: null });
    getReportGithubLinks.mockResolvedValue(linksWith(projectLink({ displayName: 'Backend Ledger' })));
    renderPage();
    const input = await screen.findByLabelText('Name on your resume');
    expect(input.value).toBe('Backend Ledger');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(updateGithubProjectDetails).toHaveBeenCalledWith('r1', 'g1', { displayName: null }));
  });

  it('shows the server’s reason when saving fails', async () => {
    updateGithubProjectDetails.mockRejectedValue({ response: { status: 400, data: { message: 'The project name cannot be empty.' } } });
    renderPage();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'I built Banking System Backend' }));
    expect(await screen.findByText(/project name cannot be empty/i)).toBeTruthy();
  });

  it('keeps repositories that are not selected as projects in the "other linked repositories" list', async () => {
    getReportGithubLinks.mockResolvedValue(
      linksWith(projectLink(), projectLink({ analysisId: 'g2', repositoryFullName: 'me/old-link', selected: false, matchedProject: null, matchSource: 'none' }))
    );
    renderPage();
    const other = await screen.findByTestId('other-linked-repos');
    expect(other.textContent).toMatch(/me\/old-link/);
    expect(other.textContent).not.toMatch(/Banking-System-backend/);
    expect(await screen.findByLabelText('Belongs to project')).toBeTruthy();
  });

  it('tells the user which GitHub projects the generated draft is made of', async () => {
    getLatestDraft.mockResolvedValue(null);
    createDraftForReport.mockResolvedValue({
      githubProjects: { configured: true, used: [{ name: 'Banking System Backend', repo: 'me/Banking-System-backend' }], skipped: [], error: null },
    });
    renderPage();
    fireEvent.click((await screen.findAllByRole('button', { name: /2\. generate resume draft/i }))[0]);
    const notice = await screen.findByText(/written from 1 GitHub project: Banking System Backend/);
    expect(notice.textContent).toMatch(/Confirm that you built each one/);
  });

  it('reports skipped repositories and a failure to write GitHub projects, without hiding the draft', async () => {
    getLatestDraft.mockResolvedValue(null);
    createDraftForReport.mockResolvedValue({
      githubProjects: {
        configured: true,
        used: [],
        skipped: [{ repo: 'me/a', reason: 'No bullets supported by the README of me/a could be written, so it was skipped.' }],
        error: 'Gemini is down',
      },
    });
    renderPage();
    fireEvent.click((await screen.findAllByRole('button', { name: /2\. generate resume draft/i }))[0]);
    const notice = await screen.findByText(/No bullets supported by the README of me\/a/);
    expect(notice.textContent).toMatch(/GitHub projects could not be written \(Gemini is down\)/);
    expect(notice.textContent).toMatch(/your resume's own projects were kept/);
  });

  it('says nothing about GitHub when no repositories are used', async () => {
    getLatestDraft.mockResolvedValue(null);
    createDraftForReport.mockResolvedValue({ githubProjects: { configured: false, used: [], skipped: [], error: null } });
    renderPage();
    fireEvent.click((await screen.findAllByRole('button', { name: /2\. generate resume draft/i }))[0]);
    const notice = await screen.findByText(/Tailored resume draft generated/);
    expect(notice.textContent).not.toMatch(/GitHub/);
  });
});

describe('VerificationPage: out-of-date draft, step states and naming resume projects', () => {
  const link = (overrides = {}) => ({
    analysisId: 'g1',
    repositoryFullName: 'me/Banking-System-backend',
    verified: true,
    explicitProjectName: null,
    matchedProject: 'Backend Ledger',
    matchSource: 'name',
    selected: true,
    inDraft: false,
    displayName: null,
    defaultName: 'Banking System Backend',
    authorshipConfirmed: false,
    ...overrides,
  });
  const data = (overrides = {}) => ({ hasDraft: true, draftProjects: ['Backend Ledger'], draftOutdated: false, links: [link()], ...overrides });
  const stepText = async (n) => {
    const steps = await screen.findByTestId('verification-steps');
    return steps.querySelectorAll('li')[n - 1];
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getVerificationRun.mockRejectedValue(notFound());
    getLatestDraft.mockResolvedValue({ projects: [] });
    getInterviewReportById.mockResolvedValue({ interviewReport: { _id: 'r1', resume: 'Some resume text here' } });
    getReportGithubLinks.mockResolvedValue(data());
  });

  it('tells the user when the saved draft was made before their GitHub projects were chosen', async () => {
    getReportGithubLinks.mockResolvedValue(data({ draftOutdated: true }));
    renderPage();
    const banner = await screen.findByTestId('draft-outdated-notice');
    expect(banner.textContent).toMatch(/made before you chose your GitHub projects/i);
    expect(banner.textContent).toMatch(/Generate the\s+draft again/i);
    expect((await stepText(2)).textContent).toMatch(/Out of date/);
  });

  it('shows no such banner when the draft is up to date', async () => {
    renderPage();
    await screen.findByTestId('github-project-links');
    expect(screen.queryByTestId('draft-outdated-notice')).toBeNull();
  });

  it('marks step 1 done when GitHub projects were chosen, and counts them', async () => {
    renderPage();
    const step1 = await stepText(1);
    await waitFor(() => expect(step1.className).toMatch(/vp-step--done/));
    expect(step1.textContent).toMatch(/1 from GitHub/);
  });

  it('keeps step 1 as the current step when there is nothing yet', async () => {
    getLatestDraft.mockResolvedValue(null);
    getReportGithubLinks.mockResolvedValue({ hasDraft: false, draftProjects: [], draftOutdated: false, links: [] });
    renderPage();
    const step1 = await stepText(1);
    expect(step1.className).toMatch(/vp-step--current/);
    expect(step1.className).not.toMatch(/vp-step--done/);
    expect(step1.textContent).toMatch(/optional/i);
  });

  it('lets the user rename a resume project that a repository is assigned to (not only GitHub-written projects)', async () => {
    updateGithubProjectDetails.mockResolvedValue({ displayName: 'Ledger Pro' });
    getReportGithubLinks.mockResolvedValue(data({ links: [link({ selected: false, matchedProject: 'Backend Ledger', matchSource: 'user', explicitProjectName: 'Backend Ledger' })] }));
    renderPage();

    const other = await screen.findByTestId('other-linked-repos');
    expect(other.textContent).toMatch(/Used as evidence for: Backend Ledger/);
    const input = await screen.findByLabelText('Name on your resume');
    fireEvent.change(input, { target: { value: 'Ledger Pro' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(updateGithubProjectDetails).toHaveBeenCalledWith('r1', 'g1', { displayName: 'Ledger Pro' }));
  });

  it('does not offer a name field for a repository that is not matched to any project yet', async () => {
    getReportGithubLinks.mockResolvedValue(data({ links: [link({ selected: false, matchedProject: null, matchSource: 'none' })] }));
    renderPage();
    await screen.findByTestId('other-linked-repos');
    expect(screen.queryByLabelText('Name on your resume')).toBeNull();
  });

  it('shows the GitHub-project note on the draft tile only when projects were chosen', async () => {
    renderPage();
    expect((await screen.findAllByText(/comes from your 1 selected GitHub project/i)).length).toBeGreaterThan(0);
  });
});
