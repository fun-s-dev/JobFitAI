const REASON_MESSAGES = {
  access_denied: 'You cancelled the GitHub authorization. Nothing was connected.',
  invalid_state: 'The GitHub sign-in link expired or was not valid. Please click Connect GitHub again.',
  invalid_request: 'GitHub did not return an authorization code. Please try again.',
  exchange_failed: 'GitHub could not complete the connection. Please try again.',
  identity_failed: 'We could not read your GitHub account after authorization. Please try again.',
  provider_error: 'GitHub reported a problem during authorization. Please try again.',
  github_account_in_use: 'That GitHub account is already connected to a different JobFitAI account.',
  not_configured: 'GitHub Connect is not configured on this server.',
  server_error: 'Something went wrong while connecting GitHub. Please try again.',
};

/**
 * Reads the `?github=connected` / `?github=error&reason=...` result that the backend callback
 * appends to the page URL, and turns it into a message for the user.
 *
 * @param {URLSearchParams} searchParams
 * @returns {{ type: 'success'|'error', message: string }|null}
 */
export function parseGithubConnectResult(searchParams) {
  const result = searchParams.get('github');
  if (result === 'connected') {
    return { type: 'success', message: 'GitHub connected. Choose a repository below to analyze.' };
  }
  if (result === 'error') {
    const reason = searchParams.get('reason');
    return {
      type: 'error',
      message: REASON_MESSAGES[reason] || 'GitHub could not be connected. Please try again.',
    };
  }
  return null;
}

/** The only place the browser is ever sent for authorization. */
export function isGithubAuthorizeUrl(url) {
  return typeof url === 'string' && url.startsWith('https://github.com/login/oauth/authorize?');
}
