import React, { useState } from 'react';
import StatusBadge from './StatusBadge';
import EvidencePanel from './EvidencePanel';

export default function ClaimRow({
  claim = {},
  onDecide,
  isMutating = false,
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  const claimId = claim.id || claim._id;
  const confidencePct =
    typeof claim.confidenceScore === 'number'
      ? `${(claim.confidenceScore * 100).toFixed(0)}%`
      : '—';

  const isApproved = claim.userOverride?.decision === 'approved';
  const isRejected = claim.userOverride?.decision === 'rejected';

  const handleApprove = (e) => {
    e.stopPropagation();
    if (typeof onDecide === 'function' && !isMutating) {
      if (claim.status === 'rejected') {
        const confirmed = window.confirm(
          'This claim was rejected by verification; include it anyway?'
        );
        if (!confirmed) return;
      }
      onDecide(claimId, 'approved');
    }
  };

  const handleReject = (e) => {
    e.stopPropagation();
    if (typeof onDecide === 'function' && !isMutating) {
      onDecide(claimId, 'rejected');
    }
  };

  return (
    <div className={`claim-row ${isExpanded ? 'claim-row--expanded' : ''}`}>
      <div className="claim-row__main">
        {/* Expand / Collapse Evidence Trigger */}
        <button
          type="button"
          className="claim-row__toggle-btn"
          aria-expanded={isExpanded}
          aria-label="Toggle evidence details"
          onClick={() => setIsExpanded((prev) => !prev)}
        >
          <svg
            className={`claim-row__chevron ${isExpanded ? 'claim-row__chevron--open' : ''}`}
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>

        {/* Claim Text & Metadata */}
        <div
          className="claim-row__content"
          onClick={() => setIsExpanded((prev) => !prev)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setIsExpanded((prev) => !prev);
            }
          }}
        >
          <p className="claim-row__text">{claim.claimText}</p>
          <div className="claim-row__meta">
            {claim.claimType && (
              <span className="claim-tag claim-tag--type">{claim.claimType}</span>
            )}
            {claim.bulletId && (
              <span className="claim-tag claim-tag--bullet">Bullet: {claim.bulletId}</span>
            )}
            <span className="claim-row__confidence">
              Confidence: <strong>{confidencePct}</strong>
            </span>
          </div>
        </div>

        {/* Status Badge */}
        <div className="claim-row__status">
          <StatusBadge status={claim.status} userOverride={claim.userOverride} />
        </div>

        {/* Action Decision Controls */}
        <div className="claim-row__actions">
          <button
            type="button"
            className={`claim-btn claim-btn--approve ${isApproved ? 'claim-btn--active' : ''}`}
            disabled={isMutating}
            aria-label="Approve claim"
            title="Approve this claim (override to verified)"
            onClick={handleApprove}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Approve
          </button>

          <button
            type="button"
            className={`claim-btn claim-btn--reject ${isRejected ? 'claim-btn--active' : ''}`}
            disabled={isMutating}
            aria-label="Reject claim"
            title="Reject this claim (exclude associated bullet)"
            onClick={handleReject}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
            Reject
          </button>
        </div>
      </div>

      {/* Expandable Evidence Details */}
      {isExpanded && (
        <div className="claim-row__evidence">
          <EvidencePanel
            entailment={claim.entailment}
            resumeEvidence={claim.resumeEvidence}
            caps={claim.caps}
            projectEvidence={claim.projectEvidence}
            projectItems={claim.projectItems || []}
          />
        </div>
      )}
    </div>
  );
}
