import React from 'react';

/**
 * Highlights a substring within a larger text block, optionally using stored [start, end] offsets.
 */
function renderHighlightedText(fullText, quote, startOffset, endOffset) {
  if (!fullText) return null;

  // 1. Try stored character offsets if provided and valid
  if (
    typeof startOffset === 'number' &&
    typeof endOffset === 'number' &&
    startOffset >= 0 &&
    endOffset > startOffset &&
    endOffset <= fullText.length
  ) {
    const before = fullText.slice(0, startOffset);
    const highlighted = fullText.slice(startOffset, endOffset);
    const after = fullText.slice(endOffset);

    return (
      <>
        {before}
        <mark className="evidence-panel__highlight">{highlighted}</mark>
        {after}
      </>
    );
  }

  // 2. Fall back to substring match for evidenceQuote
  if (quote && fullText.toLowerCase().includes(quote.toLowerCase())) {
    const idx = fullText.toLowerCase().indexOf(quote.toLowerCase());
    const before = fullText.slice(0, idx);
    const highlighted = fullText.slice(idx, idx + quote.length);
    const after = fullText.slice(idx + quote.length);

    return (
      <>
        {before}
        <mark className="evidence-panel__highlight">{highlighted}</mark>
        {after}
      </>
    );
  }

  // 3. Fallback to raw text
  return fullText;
}

export default function EvidencePanel({
  entailment = {},
  resumeEvidence = [],
  caps = [],
}) {
  const quote = entailment?.evidenceQuote || '';
  const missing = entailment?.missingElements || [];

  return (
    <div className="evidence-panel" role="region" aria-label="Evidence details">
      {/* Entailment Verdict Header */}
      <div className="evidence-panel__section">
        <div className="evidence-panel__header">
          <span className="evidence-panel__title">Entailment Verdict:</span>
          <span className={`evidence-panel__verdict evidence-panel__verdict--${entailment?.verdict || 'none'}`}>
            {entailment?.verdict ? entailment.verdict.toUpperCase() : 'UNKNOWN'}
          </span>
          {typeof entailment?.score === 'number' && (
            <span className="evidence-panel__score">
              (Score: {(entailment.score * 100).toFixed(0)}%)
            </span>
          )}
        </div>

        {quote && (
          <div className="evidence-panel__quote-box">
            <span className="evidence-panel__quote-label">Direct Quote Grounding:</span>
            <blockquote className="evidence-panel__quote">"{quote}"</blockquote>
          </div>
        )}

        {missing.length > 0 && (
          <div className="evidence-panel__missing">
            <span className="evidence-panel__missing-label">Missing or Uncorroborated Elements:</span>
            <div className="evidence-panel__tags">
              {missing.map((item, idx) => (
                <span key={idx} className="evidence-tag evidence-tag--missing">
                  {item}
                </span>
              ))}
            </div>
          </div>
        )}

        {caps.length > 0 && (
          <div className="evidence-panel__caps">
            <span className="evidence-panel__caps-label">Guardrail Rules Applied:</span>
            <div className="evidence-panel__tags">
              {caps.map((cap, idx) => (
                <span key={idx} className="evidence-tag evidence-tag--cap">
                  {cap}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Resume Source Chunks with Highlighted Quotes */}
      {resumeEvidence.length > 0 && (
        <div className="evidence-panel__section">
          <span className="evidence-panel__title">Matched Resume Evidence:</span>
          <div className="evidence-panel__chunks">
            {resumeEvidence.map((ev, idx) => (
              <div key={idx} className="evidence-chunk">
                <div className="evidence-chunk__meta">
                  <span className="evidence-chunk__source">Source: {ev.source || 'resume'}</span>
                  {ev.section && <span className="evidence-chunk__section">[{ev.section}]</span>}
                  {typeof ev.similarityScore === 'number' && (
                    <span className="evidence-chunk__sim">
                      Sim: {(ev.similarityScore * 100).toFixed(0)}%
                    </span>
                  )}
                </div>
                <p className="evidence-chunk__text">
                  {renderHighlightedText(ev.text, quote, ev.start, ev.end)}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
