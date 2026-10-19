class InvalidRepoUrlError extends Error {
  constructor(message = 'Invalid GitHub repository URL') {
    super(message);
    this.name = 'InvalidRepoUrlError';
  }
}

const IDENT_REGEX = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * Parses and strictly validates a GitHub repository URL.
 * Only accepts https://github.com/<owner>/<repo>(.git)? with optional trailing slash.
 * Rejects localhost, IPs, spoofed domains, userinfo tricks, traversal paths, extra segments.
 *
 * @param {string} inputUrl
 * @returns {{ owner: string, repo: string, repositoryFullName: string }}
 * @throws {InvalidRepoUrlError}
 */
function parseRepoUrl(inputUrl) {
  if (typeof inputUrl !== 'string' || !inputUrl.trim()) {
    throw new InvalidRepoUrlError('Repository URL must be a non-empty string');
  }

  const trimmed = inputUrl.trim();

  // Reject path traversal and backslashes in raw string
  if (trimmed.includes('..') || trimmed.includes('\\')) {
    throw new InvalidRepoUrlError('URL contains illegal characters or path traversal');
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new InvalidRepoUrlError('Malformed URL');
  }

  // Enforce HTTPS
  if (parsed.protocol !== 'https:') {
    throw new InvalidRepoUrlError('Only HTTPS GitHub URLs are allowed');
  }

  // Enforce strict hostname
  if (parsed.hostname.toLowerCase() !== 'github.com') {
    throw new InvalidRepoUrlError('Host must be strictly github.com');
  }

  // Reject credentials / userinfo
  if (parsed.username || parsed.password) {
    throw new InvalidRepoUrlError('User credentials in repository URL are prohibited');
  }

  // Reject non-default port
  if (parsed.port && parsed.port !== '443') {
    throw new InvalidRepoUrlError('Non-standard ports are prohibited');
  }

  // Reject query parameters or fragments
  if (parsed.search || parsed.hash) {
    throw new InvalidRepoUrlError('Query parameters and hash fragments are not allowed');
  }

  // Path segments validation
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length !== 2) {
    throw new InvalidRepoUrlError('URL must point directly to a repository: /<owner>/<repo>');
  }

  const [rawOwner, rawRepo] = segments;

  let cleanRepo = rawRepo;
  if (cleanRepo.toLowerCase().endsWith('.git')) {
    cleanRepo = cleanRepo.slice(0, -4);
  }

  if (!IDENT_REGEX.test(rawOwner) || rawOwner === '.' || rawOwner === '..') {
    throw new InvalidRepoUrlError(`Invalid repository owner: "${rawOwner}"`);
  }

  if (!IDENT_REGEX.test(cleanRepo) || cleanRepo === '.' || cleanRepo === '..' || cleanRepo.length === 0) {
    throw new InvalidRepoUrlError(`Invalid repository name: "${cleanRepo}"`);
  }

  return {
    owner: rawOwner,
    repo: cleanRepo,
    repositoryFullName: `${rawOwner}/${cleanRepo}`,
  };
}

module.exports = {
  parseRepoUrl,
  InvalidRepoUrlError,
};
