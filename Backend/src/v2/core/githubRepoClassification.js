/**
 * Classifies a GitHub repository for a connected GitHub identity.
 *
 * Three concepts are kept SEPARATE on purpose:
 *   - control      : the connected GitHub account OWNS this repository (identity match).
 *   - writeAccess  : collaborator / maintainer rights. NOT assessed in the identity-first phase.
 *   - authorship   : who wrote the code. NEVER assessed; owning a repository does not prove that
 *                    its code was written by the owner.
 *
 * Pure module: no I/O.
 */

const UNSUPPORTED = Object.freeze({
  PRIVATE: 'private_unsupported',
  NOT_OWNED: 'not_owned',
  FORK: 'fork_unsupported',
  ARCHIVED: 'archived',
  DISABLED: 'disabled',
});

const UNSUPPORTED_MESSAGES = Object.freeze({
  [UNSUPPORTED.PRIVATE]: 'Private repositories are not supported in this version.',
  [UNSUPPORTED.NOT_OWNED]:
    'This repository is not owned by your connected GitHub account. Collaborator and organization repositories are not supported yet.',
  [UNSUPPORTED.FORK]:
    'Forks are not supported: controlling a fork does not show that the code is yours.',
  [UNSUPPORTED.ARCHIVED]: 'Archived repositories are not supported.',
  [UNSUPPORTED.DISABLED]: 'This repository is disabled on GitHub.',
});

/**
 * @param {object} repo - Repository object as returned by the GitHub REST API
 * @param {{ githubUserId: number }} identity - The authenticated GitHub identity
 */
function classifyRepository(repo, identity) {
  const ownerId = repo && repo.owner ? repo.owner.id : null;
  const ownerIsAuthenticatedUser =
    ownerId !== null &&
    ownerId === identity.githubUserId &&
    (repo.owner.type === undefined || repo.owner.type === 'User');

  const visibility = repo.private || repo.visibility === 'private' || repo.visibility === 'internal' ? 'private' : 'public';

  // Reasons are ordered by how fundamental they are; the first match is reported.
  let unsupportedReason = null;
  if (visibility === 'private') unsupportedReason = UNSUPPORTED.PRIVATE;
  else if (!ownerIsAuthenticatedUser) unsupportedReason = UNSUPPORTED.NOT_OWNED;
  else if (repo.fork) unsupportedReason = UNSUPPORTED.FORK;
  else if (repo.archived) unsupportedReason = UNSUPPORTED.ARCHIVED;
  else if (repo.disabled) unsupportedReason = UNSUPPORTED.DISABLED;

  return {
    repoId: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    htmlUrl: repo.html_url,
    description: typeof repo.description === 'string' ? repo.description.slice(0, 300) : null,
    language: repo.language || null,
    pushedAt: repo.pushed_at || null,
    visibility,
    isFork: Boolean(repo.fork),
    isArchived: Boolean(repo.archived),
    control: {
      verified: ownerIsAuthenticatedUser && visibility === 'public',
      level: ownerIsAuthenticatedUser ? 'owner' : 'none',
      basis: ownerIsAuthenticatedUser ? 'authenticated_github_account_is_repository_owner' : null,
    },
    writeAccess: 'not_assessed',
    authorship: 'not_assessed',
    selectable: unsupportedReason === null,
    unsupportedReason,
    unsupportedMessage: unsupportedReason ? UNSUPPORTED_MESSAGES[unsupportedReason] : null,
  };
}

module.exports = { classifyRepository, UNSUPPORTED };
