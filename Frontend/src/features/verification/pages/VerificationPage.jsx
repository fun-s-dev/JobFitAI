import React, { useState } from 'react';
import { useParams, Link } from 'react-router';
import '../style/verification.scss';
import { useVerification } from '../hooks/useVerification';
import { useJob } from '../hooks/useJob';
import { useClaimDecision } from '../hooks/useClaimDecision';
import SummaryBar from '../components/SummaryBar';
import ClaimRow from '../components/ClaimRow';
import GithubLinkForm from '../components/GithubLinkForm';
import {
  startVerificationJob,
  getPrintDraftUrl,
  downloadGroundedPdf,
  createDraftForReport,
} from '../services/verification.api';

export default function VerificationPage() {
  const { interviewId, id } = useParams();
  const reportId = interviewId || id;

  const [activeJobId, setActiveJobId] = useState(null);
  const [filterStatus, setFilterStatus] = useState('all');
  const [isStartingJob, setIsStartingJob] = useState(false);
  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false);
  const [isPdfDisabled, setIsPdfDisabled] = useState(false);
  const [pdfError, setPdfError] = useState(null);
  const [isGeneratingDraft, setIsGeneratingDraft] = useState(false);
  const [draftNotice, setDraftNotice] = useState(null);
  const [draftError, setDraftError] = useState(null);
  const [printNotice, setPrintNotice] = useState(null);
  const [linkedAnalysisIds, setLinkedAnalysisIds] = useState([]);

  const {
    run,
    claims,
    grounded,
    isLoading: isVerifyingLoading,
    isWakingUp,
    isError: isVerifyingError,
    error: verifyError,
    refetch,
  } = useVerification(reportId);

  const activeJob = useJob(activeJobId, {
    onDone: () => {
      refetch();
    },
    onFailed: (failedJob) => {
      console.error('Job failed:', failedJob.error);
    },
  });

  const claimDecisionMutation = useClaimDecision(reportId);

  // Start verification handler
  const handleStartVerification = async () => {
    setIsStartingJob(true);
    setDraftError(null);
    setPrintNotice(null);
    try {
      const data = await startVerificationJob(reportId, {
        githubAnalysisIds: linkedAnalysisIds.length > 0 ? linkedAnalysisIds : undefined,
      });
      if (data.jobId) {
        setActiveJobId(data.jobId);
      }
    } catch (err) {
      console.error('Failed to trigger verification job:', err);
    } finally {
      setIsStartingJob(false);
    }
  };

  // Generate resume draft (M2 endpoint)
  const handleGenerateDraft = async () => {
    setIsGeneratingDraft(true);
    setDraftError(null);
    setDraftNotice(null);
    try {
      await createDraftForReport(reportId);
      setDraftNotice('Tailored resume draft generated successfully! You can now run verification.');
    } catch (err) {
      setDraftError(
        err.response?.data?.error?.message ||
          'Failed to generate draft. Ensure the interview report has resume text.'
      );
    } finally {
      setIsGeneratingDraft(false);
    }
  };

  // Print handler: opens print URL with strict CSP
  const handlePrint = () => {
    const printUrl = getPrintDraftUrl(reportId, run?._id);
    const printWindow = window.open(printUrl, '_blank');
    if (printWindow) {
      printWindow.focus();
    }
    setPrintNotice(
      'Print preview opened in a new tab. Because exports are delivered under a strict zero-script Content Security Policy, press Ctrl+P (Cmd+P on Mac) in the new tab to print or save as PDF.'
    );
  };

  // Download PDF handler
  const handleDownloadPdf = async () => {
    setIsDownloadingPdf(true);
    setPdfError(null);
    try {
      const blob = await downloadGroundedPdf(reportId, run?._id);
      const url = window.URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', 'grounded-resume.pdf');
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      if (err.response?.status === 501) {
        setIsPdfDisabled(true);
        setPdfError('server PDF is disabled; use Print / Save as PDF');
      } else {
        setPdfError(
          err.response?.data?.error?.message ||
            'Failed to download PDF. Try printing directly from your browser.'
        );
      }
    } finally {
      setIsDownloadingPdf(false);
    }
  };

  // Claim decision handler (Approve / Reject)
  const handleClaimDecision = (claimId, decision) => {
    claimDecisionMutation.mutate({ claimId, decision });
  };

  // Filter claims
  const filteredClaims = claims.filter((claim) => {
    if (filterStatus === 'all') return true;
    const effective = claim.userOverride?.decision || claim.status;
    if (filterStatus === 'verified') return effective === 'verified' || effective === 'approved';
    if (filterStatus === 'needs_review') return effective === 'needs_review';
    if (filterStatus === 'rejected') return effective === 'rejected';
    return true;
  });

  return (
    <div className="verification-page">
      <div className="verification-page__layout">
        {/* Header Bar */}
        <header className="verification-page__header">
          <div className="verification-page__header-left">
            <Link to={`/interview/${reportId}`} className="button secondary-button" style={{ marginBottom: '0.5rem', display: 'inline-flex' }}>
              &larr; Back to Interview Prep
            </Link>
            <h1>Resume Verification & Grounded Export</h1>
            <p>
              Audits every atomic resume bullet claim against primary evidence with natural language inference.
            </p>
          </div>

          <div className="verification-page__header-actions" style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
            <button
              type="button"
              className="button secondary-button"
              onClick={handleGenerateDraft}
              disabled={isGeneratingDraft || activeJob.isRunning}
              title="Tailors a fresh ResumeDraft for this report using Gemini (costs 1 Gemini call)"
            >
              {isGeneratingDraft ? 'Generating Draft (Gemini)...' : 'Generate Resume Draft'}
            </button>

            {!activeJob.isRunning && (
              <button
                type="button"
                className="button primary-button"
                onClick={handleStartVerification}
                disabled={isStartingJob || isGeneratingDraft}
              >
                {isStartingJob
                  ? 'Queueing Job...'
                  : claims.length > 0
                  ? 'Re-Run Verification'
                  : 'Run Verification'}
              </button>
            )}
          </div>
        </header>

        {/* Gemini Cost & Confidence Note */}
        <div style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.6)', marginTop: '-0.5rem', marginBottom: '1rem', textAlign: 'right' }}>
          * Generating draft costs 1 Gemini call. Verification evaluates claims via embeddings and entailment.<br />
          * Confidence is a ranking score, not a probability.
        </div>

        {/* Draft Notice / Error */}
        {draftNotice && (
          <div className="verification-page__waking-alert" role="status" style={{ background: 'rgba(52, 211, 153, 0.15)', borderColor: 'rgba(52, 211, 153, 0.4)', color: '#34d399' }}>
            <span>✓ {draftNotice}</span>
          </div>
        )}
        {draftError && (
          <div className="verification-page__error-alert" role="alert">
            <strong>Draft Error: </strong>{draftError}
          </div>
        )}

        {/* Print Instruction Alert */}
        {printNotice && (
          <div className="verification-page__waking-alert" role="status" style={{ background: 'rgba(96, 165, 250, 0.15)', borderColor: 'rgba(96, 165, 250, 0.4)', color: '#60a5fa' }}>
            <span>🖨 {printNotice}</span>
          </div>
        )}


        {/* Free-tier server wake-up notification */}
        {isWakingUp && (
          <div className="verification-page__waking-alert" role="status">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <span>
              Server is waking up... Please wait a few seconds while instances initialize.
            </span>
          </div>
        )}

        {/* Error notification */}
        {(isVerifyingError || activeJob.isFailed) && (
          <div className="verification-page__error-alert" role="alert">
            <strong>Verification Notice: </strong>
            {activeJob.error?.message ||
              verifyError?.response?.data?.error?.message ||
              'Unable to load or run verification at this time. Please check your connection.'}
          </div>
        )}

        {/* Loading state */}
        {isVerifyingLoading && !isWakingUp && (
          <div className="loading-screen" style={{ minHeight: '200px' }}>
            <p>Loading verification audit records...</p>
          </div>
        )}

        {/* GitHub Repository Evidence Form */}
        <GithubLinkForm
          reportId={reportId}
          onAnalysisComplete={(analysis) => {
            if (analysis?._id) {
              setLinkedAnalysisIds((prev) => Array.from(new Set([...prev, analysis._id])));
            }
          }}
        />

        {/* Summary Bar */}
        {(claims.length > 0 || activeJob.isRunning) && (
          <SummaryBar
            claims={claims}
            grounded={grounded}
            activeJob={activeJob}
            onPrint={handlePrint}
            onDownloadPdf={handleDownloadPdf}
            isDownloadingPdf={isDownloadingPdf}
            isPdfDisabled={isPdfDisabled}
            pdfError={pdfError}
          />
        )}

        {/* Filter controls */}
        {claims.length > 0 && (
          <div className="filter-bar" role="toolbar" aria-label="Filter claims by status">
            <button
              type="button"
              className={`filter-bar__btn ${filterStatus === 'all' ? 'filter-bar__btn--active' : ''}`}
              onClick={() => setFilterStatus('all')}
            >
              All Claims ({claims.length})
            </button>
            <button
              type="button"
              className={`filter-bar__btn ${filterStatus === 'needs_review' ? 'filter-bar__btn--active' : ''}`}
              onClick={() => setFilterStatus('needs_review')}
            >
              Needs Review
            </button>
            <button
              type="button"
              className={`filter-bar__btn ${filterStatus === 'verified' ? 'filter-bar__btn--active' : ''}`}
              onClick={() => setFilterStatus('verified')}
            >
              Verified / Approved
            </button>
            <button
              type="button"
              className={`filter-bar__btn ${filterStatus === 'rejected' ? 'filter-bar__btn--active' : ''}`}
              onClick={() => setFilterStatus('rejected')}
            >
              Rejected
            </button>
          </div>
        )}

        {/* Claim Rows List */}
        {claims.length > 0 ? (
          <div className="claim-list">
            {filteredClaims.map((claim) => (
              <ClaimRow
                key={claim.id || claim._id}
                claim={claim}
                onDecide={handleClaimDecision}
                isMutating={claimDecisionMutation.isPending}
              />
            ))}
          </div>
        ) : (
          !isVerifyingLoading &&
          !activeJob.isRunning && (
            <div className="card" style={{ textAlign: 'center', padding: '3rem 1rem' }}>
              <h2>No Verification Run Yet</h2>
              <p style={{ color: '#7d8590', maxWidth: '480px', margin: '0.5rem auto 1.5rem auto' }}>
                Verify your resume draft claims against original resume evidence and GitHub repositories to produce a 100% grounded, ATS-optimized export.
              </p>
              <button
                type="button"
                className="button primary-button"
                onClick={handleStartVerification}
                disabled={isStartingJob}
              >
                {isStartingJob ? 'Queueing Job...' : 'Start Fact-Checking Verification'}
              </button>
            </div>
          )
        )}
      </div>
    </div>
  );
}
