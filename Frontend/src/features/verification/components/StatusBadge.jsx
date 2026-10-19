import React from 'react';

/**
 * StatusBadge component: text + icon, not color alone (WCAG accessible).
 * Supports automated status and user override decisions.
 */
export default function StatusBadge({ status, userOverride = null }) {
  const isOverride = Boolean(userOverride?.decision);
  const effectiveStatus = isOverride ? userOverride.decision : status;

  // Icon definitions (inline SVG for portability and zero dependencies)
  const icons = {
    verified: (
      <svg
        aria-hidden="true"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
      </svg>
    ),
    needs_review: (
      <svg
        aria-hidden="true"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    ),
    rejected: (
      <svg
        aria-hidden="true"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      </svg>
    ),
    approved: (
      <svg
        aria-hidden="true"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    ),
  };

  const getLabel = () => {
    if (isOverride) {
      return effectiveStatus === 'approved' ? 'Approved (Override)' : 'Rejected (Override)';
    }
    switch (status) {
      case 'verified':
        return 'Verified';
      case 'needs_review':
        return 'Needs Review';
      case 'rejected':
        return 'Rejected';
      default:
        return 'Pending';
    }
  };

  const badgeClass = `status-badge status-badge--${effectiveStatus}${
    isOverride ? ' status-badge--override' : ''
  }`;

  return (
    <span className={badgeClass} role="status" aria-label={`Status: ${getLabel()}`}>
      <span className="status-badge__icon">
        {icons[effectiveStatus] || icons[status] || icons.needs_review}
      </span>
      <span className="status-badge__text">{getLabel()}</span>
    </span>
  );
}
