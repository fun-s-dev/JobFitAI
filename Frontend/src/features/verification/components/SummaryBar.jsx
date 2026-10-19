import React, { useState } from 'react';

export default function SummaryBar({
  claims = [],
  grounded = null,
  activeJob = null,
  onPrint,
  onDownloadPdf,
  isDownloadingPdf = false,
  isPdfDisabled = false,
  pdfError = null,
}) {
  const [showExcluded, setShowExcluded] = useState(false);

  // Calculate claim summary stats
  const totalClaims = claims.length;
  let verifiedCount = 0;
  let needsReviewCount = 0;
  let rejectedCount = 0;
  let overrideCount = 0;

  for (const c of claims) {
    if (c.userOverride?.decision) overrideCount++;
    const eff = c.userOverride?.decision || c.status;
    if (eff === 'verified' || eff === 'approved') verifiedCount++;
    else if (eff === 'needs_review') needsReviewCount++;
    else if (eff === 'rejected') rejectedCount++;
  }

  const excludedBullets = grounded?.excludedBullets || [];
  const allowedBulletIds = grounded?.allowedBulletIds || [];

  return (
    <div className="summary-bar">
      {/* Active Job Progress Bar */}
      {activeJob?.isRunning && (
        <div className="summary-bar__job-progress" role="status" aria-live="polite">
          <div className="summary-bar__job-header">
            <span className="summary-bar__job-title">
              <span className="summary-bar__spinner" aria-hidden="true" />
              Verification in progress...
            </span>
            <span className="summary-bar__job-text">
              {activeJob.progressText || 'Processing...'}
            </span>
          </div>
          <div className="summary-bar__progress-track">
            <div
              className="summary-bar__progress-fill"
              style={{ width: `${activeJob.progressPercent || 5}%` }}
              role="progressbar"
              aria-valuenow={activeJob.progressPercent || 0}
              aria-valuemin="0"
              aria-valuemax="100"
            />
          </div>
        </div>
      )}

      {/* Metrics Counter Cards */}
      <div className="summary-bar__metrics">
        <div className="metric-card metric-card--total">
          <span className="metric-card__value">{totalClaims}</span>
          <span className="metric-card__label">Total Claims</span>
        </div>

        <div className="metric-card metric-card--verified">
          <span className="metric-card__value">{verifiedCount}</span>
          <span className="metric-card__label">Verified / Approved</span>
        </div>

        <div className="metric-card metric-card--review">
          <span className="metric-card__value">{needsReviewCount}</span>
          <span className="metric-card__label">Needs Review</span>
        </div>

        <div className="metric-card metric-card--rejected">
          <span className="metric-card__value">{rejectedCount}</span>
          <span className="metric-card__label">Rejected</span>
        </div>

        <div className="metric-card metric-card--override">
          <span className="metric-card__value">{overrideCount}</span>
          <span className="metric-card__label">User Overrides</span>
        </div>
      </div>

      {/* Grounded Resume Export Action Area */}
      <div className="summary-bar__export-box">
        <div className="summary-bar__export-header">
          <div>
            <h3 className="summary-bar__export-title">Grounded Resume Export</h3>
            <p className="summary-bar__export-desc">
              Only bullets where <strong>every attached claim</strong> is verified or approved reach the final resume.
            </p>
          </div>

          <div className="summary-bar__export-buttons">
            <button
              type="button"
              className="summary-btn summary-btn--print"
              onClick={onPrint}
              title="Open self-contained grounded print view and browser print dialog"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 6 2 18 2 18 9" />
                <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                <rect x="6" y="14" width="12" height="8" />
              </svg>
              Print / Save as PDF
            </button>

            <button
              type="button"
              className="summary-btn summary-btn--download"
              onClick={onDownloadPdf}
              disabled={isDownloadingPdf || isPdfDisabled}
              title={isPdfDisabled ? 'server PDF is disabled; use Print / Save as PDF' : 'Download ATS-formatted grounded PDF generated via Puppeteer'}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              {isDownloadingPdf ? 'Generating PDF...' : 'Download PDF'}
            </button>
          </div>
        </div>

        {(isPdfDisabled || pdfError) && (
          <div className="summary-bar__error-notice" role="alert">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{isPdfDisabled ? 'server PDF is disabled; use Print / Save as PDF' : pdfError}</span>
          </div>
        )}

        {/* Excluded Bullets Toggle & Breakdown */}
        {excludedBullets.length > 0 ? (
          <div className="summary-bar__exclusions">
            <button
              type="button"
              className="summary-bar__exclusions-toggle"
              aria-expanded={showExcluded}
              onClick={() => setShowExcluded((prev) => !prev)}
            >
              <span className="summary-bar__exclusions-count">
                ⚠ {excludedBullets.length} bullet{excludedBullets.length > 1 ? 's' : ''} excluded from export
              </span>
              <span className="summary-bar__exclusions-arrow">
                {showExcluded ? 'Hide details ▲' : 'Show details ▼'}
              </span>
            </button>

            {showExcluded && (
              <div className="summary-bar__exclusions-list">
                {excludedBullets.map((item, idx) => (
                  <div key={idx} className="excluded-bullet-item">
                    <div className="excluded-bullet-item__header">
                      <span className="excluded-bullet-item__id">Bullet ID: {item.bulletId}</span>
                      <span className="excluded-bullet-item__tag">Dropped</span>
                    </div>
                    <p className="excluded-bullet-item__text">"{item.bulletText}"</p>
                    <ul className="excluded-bullet-item__reasons">
                      {item.reasons.map((r, rIdx) => (
                        <li key={rIdx}>{r}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          grounded && (
            <div className="summary-bar__all-clean">
              ✓ All {allowedBulletIds.length} bullets supported by verified or approved claims. Zero bullets dropped.
            </div>
          )
        )}
      </div>
    </div>
  );
}
