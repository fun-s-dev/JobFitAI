import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../src/features/verification/services/verification.api', () => ({
  getGithubConnection: vi.fn(),
  startGithubConnect: vi.fn(),
  listGithubRepos: vi.fn(),
  disconnectGithub: vi.fn(),
  startGitHubRepoAnalysis: vi.fn(),
  startGitHubAnalysis: vi.fn(),
  getGitHubAnalysis: vi.fn(),
  getJobById: vi.fn(),
}));

import {
  getGithubConnection,
  startGithubConnect,
  listGithubRepos,
  disconnectGithub,
  startGitHubRepoAnalysis,
  getGitHubAnalysis,
  getJobById,
} from '../src/features/verification/services/verification.api';
import GithubConnectPanel from '../src/features/verification/components/GithubConnectPanel';
import { parseGithubConnectResult, isGithubAuthorizeUrl } from '../src/features/verification/utils/githubConnectMessages';

const REPORT_ID = '507f1f77bcf86cd799439011';
const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize?client_id=abc&state=s&code_challenge=c&code_challenge_method=S256';

const repos = [
  { repoId: 1, fullName: 'alice-gh/portfolio', description: 'My site', selectable: true, control: { verified: true }, isFork: false, isArchived: false },
  { repoId: 2, fullName: 'alice-gh/forked-lib', selectable: false, unsupportedMessage: 'Forks are not supported: controlling a fork does not show that the code is yours.', control: { verified: false }, isFork: true },
  { repoId: 3, fullName: 'alice-gh/old', selectable: false, unsupportedMessage: 'Archived repositories are not supported.', control: { verified: false }, isArchived: true },
];

function renderPanel(props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onAnalysisComplete = vi.fn();
  const navigate = vi.fn();
  const utils = render(
    <QueryClientProvider client={client}>
      <GithubConnectPanel reportId={REPORT_ID} onAnalysisComplete={onAnalysisComplete} navigate={navigate} {...props} />
    </QueryClientProvider>
  );
  return { ...utils, onAnalysisComplete, navigate };
}

describe('GithubConnectPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('always states that connecting proves control, not authorship', async () => {
    getGithubConnection.mockResolvedValue({ configured: true, connected: false });
    renderPanel();
    expect(await screen.findByText(/does not prove that you/i)).toBeDefined();
  });

  it('explains when GitHub Connect is not configured on the server and offers no Connect button', async () => {
    getGithubConnection.mockResolvedValue({ configured: false, connected: false });
    renderPanel();
    expect(await screen.findByText(/not set up on this server/i)).toBeDefined();
    expect(screen.queryByRole('button', { name: /connect github/i })).toBeNull();
  });

  it('starts the authorization with a safe return path and sends the browser to GitHub', async () => {
    getGithubConnection.mockResolvedValue({ configured: true, connected: false });
    startGithubConnect.mockResolvedValue({ authorizeUrl: AUTHORIZE_URL });
    const { navigate } = renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Connect GitHub' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(AUTHORIZE_URL));
    expect(startGithubConnect).toHaveBeenCalledWith(`/interview/${REPORT_ID}/verify`);
    expect(screen.getByText(/requests no repository permissions/i)).toBeDefined();
  });

  it('refuses to navigate anywhere except the GitHub authorize endpoint', async () => {
    getGithubConnection.mockResolvedValue({ configured: true, connected: false });
    startGithubConnect.mockResolvedValue({ authorizeUrl: 'https://evil.example.com/login/oauth/authorize?x=1' });
    const { navigate } = renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Connect GitHub' }));

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('shows the server message when starting the connection fails', async () => {
    getGithubConnection.mockResolvedValue({ configured: true, connected: false });
    startGithubConnect.mockRejectedValue({ response: { status: 429, data: { message: 'Too many GitHub connection requests, please try again later' } } });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Connect GitHub' }));
    expect(await screen.findByText(/too many github connection requests/i)).toBeDefined();
  });

  it('prompts to reconnect when the connection expired or was revoked', async () => {
    getGithubConnection.mockResolvedValue({ configured: true, connected: false, needsReconnect: true, login: 'alice-gh' });
    renderPanel();
    expect(await screen.findByText(/expired or was revoked/i)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Reconnect GitHub' })).toBeDefined();
  });

  describe('when connected', () => {
    beforeEach(() => {
      getGithubConnection.mockResolvedValue({ configured: true, connected: true, login: 'alice-gh' });
      listGithubRepos.mockResolvedValue({ login: 'alice-gh', repos, scope: { privateRepositories: 'unsupported' } });
    });

    it('lists repositories, disables unsupported ones with their reason, and says private repositories are unsupported', async () => {
      renderPanel();

      expect(await screen.findByText('@alice-gh')).toBeDefined();
      expect(await screen.findByText('alice-gh/portfolio')).toBeDefined();
      expect(screen.getByText(/you own this repository/i)).toBeDefined();

      expect(screen.getByLabelText('Select alice-gh/portfolio').disabled).toBe(false);
      expect(screen.getByLabelText('Select alice-gh/forked-lib').disabled).toBe(true);
      expect(screen.getByLabelText('Select alice-gh/old').disabled).toBe(true);
      expect(screen.getByText(/forks are not supported/i)).toBeDefined();
      expect(screen.getByText(/archived repositories are not supported/i)).toBeDefined();
      expect(screen.getByText(/private repositories are not supported in this version/i)).toBeDefined();
    });

    it('requires a selection before analysis can start', async () => {
      renderPanel();
      const analyze = await screen.findByRole('button', { name: /analyze selected repository/i });
      expect(analyze.disabled).toBe(true);
      expect(startGitHubRepoAnalysis).not.toHaveBeenCalled();
    });

    it('analyzes the selected repository by id and reports verified ownership without claiming authorship', async () => {
      startGitHubRepoAnalysis.mockResolvedValue({ jobId: 'job-1', status: 'queued', ownershipVerified: true });
      getJobById.mockResolvedValue({ job: { _id: 'job-1', status: 'done', resultRef: 'analysis-1', progress: { done: 3, total: 3 } } });
      getGitHubAnalysis.mockResolvedValue({
        analysis: { _id: 'analysis-1', repositoryFullName: 'alice-gh/portfolio' },
        control: { verified: true, method: 'github_app_identity', githubLogin: 'alice-gh' },
        authorship: 'not_assessed',
      });
      const { onAnalysisComplete } = renderPanel();

      fireEvent.click(await screen.findByLabelText('Select alice-gh/portfolio'));
      fireEvent.click(screen.getByRole('button', { name: /analyze selected repository/i }));

      await waitFor(() => expect(startGitHubRepoAnalysis).toHaveBeenCalledWith(REPORT_ID, 1));
      const done = await screen.findByText(/ownership verified/i);
      expect(done.textContent).toMatch(/authorship of the code is not verified/i);
      expect(done.textContent).toMatch(/counts toward verification/i);
      expect(onAnalysisComplete).toHaveBeenCalledWith(
        { _id: 'analysis-1', repositoryFullName: 'alice-gh/portfolio' },
        { verified: true, method: 'github_app_identity', githubLogin: 'alice-gh' }
      );
    });

    it('shows the server reason when a repository is rejected (for example not owned)', async () => {
      startGitHubRepoAnalysis.mockRejectedValue({
        response: { status: 403, data: { message: 'This repository is not owned by your connected GitHub account.', error: { code: 'REPO_NOT_OWNED', message: 'This repository is not owned by your connected GitHub account.' } } },
      });
      renderPanel();

      fireEvent.click(await screen.findByLabelText('Select alice-gh/portfolio'));
      fireEvent.click(screen.getByRole('button', { name: /analyze selected repository/i }));

      expect(await screen.findByText(/not owned by your connected github account/i)).toBeDefined();
    });

    it('disconnects and then offers Connect GitHub again', async () => {
      disconnectGithub.mockResolvedValue({ disconnected: true });
      renderPanel();
      await screen.findByText('@alice-gh');

      getGithubConnection.mockResolvedValue({ configured: true, connected: false });
      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

      await waitFor(() => expect(disconnectGithub).toHaveBeenCalledTimes(1));
      expect(await screen.findByRole('button', { name: 'Connect GitHub' })).toBeDefined();
      expect(screen.queryByText('alice-gh/portfolio')).toBeNull();
    });

    it('shows a repository-listing failure (for example GitHub rate limit) instead of an empty list', async () => {
      listGithubRepos.mockRejectedValue({ response: { status: 429, data: { message: 'GitHub rate limit reached. Please try again later.' } } });
      renderPanel();
      expect(await screen.findByText(/github rate limit reached/i)).toBeDefined();
    });
  });

  it('keeps the pasted-URL option but labels it as not verified', async () => {
    getGithubConnection.mockResolvedValue({ configured: true, connected: false });
    renderPanel();
    expect(await screen.findByText(/paste a public repository url \(ownership not verified\)/i)).toBeDefined();
    expect(screen.getByText(/does not count toward verification/i)).toBeDefined();
  });
});

describe('parseGithubConnectResult', () => {
  const parse = (q) => parseGithubConnectResult(new URLSearchParams(q));

  it('returns nothing when the page was not reached through the GitHub callback', () => {
    expect(parse('')).toBeNull();
    expect(parse('foo=bar')).toBeNull();
  });

  it('reports a successful connection', () => {
    expect(parse('github=connected')).toMatchObject({ type: 'success' });
  });

  it.each([
    ['access_denied', /cancelled/i],
    ['invalid_state', /expired or was not valid/i],
    ['github_account_in_use', /already connected to a different jobfitai account/i],
    ['exchange_failed', /could not complete/i],
    ['not_configured', /not configured/i],
    ['totally_unknown_reason', /could not be connected/i],
  ])('maps reason %s to a readable message', (reason, pattern) => {
    const result = parse(`github=error&reason=${reason}`);
    expect(result.type).toBe('error');
    expect(result.message).toMatch(pattern);
  });

  it('never echoes arbitrary reason text from the URL into the page', () => {
    const result = parse('github=error&reason=<script>alert(1)</script>');
    expect(result.message).not.toContain('<script>');
  });
});

describe('isGithubAuthorizeUrl', () => {
  it('accepts only the GitHub authorize endpoint over https', () => {
    expect(isGithubAuthorizeUrl(AUTHORIZE_URL)).toBe(true);
    expect(isGithubAuthorizeUrl('http://github.com/login/oauth/authorize?x=1')).toBe(false);
    expect(isGithubAuthorizeUrl('https://github.com.evil.com/login/oauth/authorize?x=1')).toBe(false);
    expect(isGithubAuthorizeUrl('https://github.com/login/oauth/authorize')).toBe(false);
    expect(isGithubAuthorizeUrl(undefined)).toBe(false);
  });
});
