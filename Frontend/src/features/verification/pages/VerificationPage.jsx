import React, { useState, useEffect } from 'react';
import { useParams, Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import '../style/verification.scss';
import { useVerification } from '../hooks/useVerification';
import { useJob } from '../hooks/useJob';
import { useClaimDecision } from '../hooks/useClaimDecision';
import SummaryBar from '../components/SummaryBar';
import ClaimRow from '../components/ClaimRow';
import GithubConnectPanel from '../components/GithubConnectPanel';
import GithubProjectLinks from '../components/GithubProjectLinks';
import ProjectRankingPanel from '../components/ProjectRankingPanel';
import { useGithubLinks } from '../hooks/useGithubLinks';
import { parseGithubConnectResult } from '../utils/githubConnectMessages';
import {
  startVerificationJob,
  getPrintDraftUrl,
  downloadGroundedPdf,
  createDraftForReport,
  getLatestDraft,
} from '../services/verification.api';
import { getInterviewReportById } from '../../interview/services/interview.api';

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
  const [startError, setStartError] = useState(null);
  const [githubResult, setGithubResult] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  // Linked repositories are stored on the server, so they survive a reload
  const githubLinks = useGithubLinks(reportId);

  // The backend callback redirects here with ?github=connected or ?github=error&reason=...
  useEffect(() => {
    const result = parseGithubConnectResult(searchParams);
    if (!result) return;
    setGithubResult(result);
    queryClient.invalidateQueries({ queryKey: ['githubConnection'] });
    queryClient.invalidateQueries({ queryKey: ['githubRepos'] });
    const next = new URLSearchParams(searchParams);
    next.delete('github');
    next.delete('reason');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, queryClient]);

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

  // Does a draft exist yet? Verification needs one, so the Verify button waits for it.
  const draftQuery = useQuery({
    queryKey: ['draft', reportId],
    queryFn: () => getLatestDraft(reportId),
    enabled: Boolean(reportId),
    staleTime: 30000,
  });
  const hasDraft = Boolean(draftQuery.data) || claims.length > 0 || Boolean(run);
  // If the draft lookup itself failed, do not block the user; the server still validates.
  const canVerify = hasDraft || draftQuery.isError;

  // Which source material the draft is built from (the plan's own resume, never a new upload).
  const reportQuery = useQuery({
    queryKey: ['report', reportId],
    queryFn: () => getInterviewReportById(reportId),
    enabled: Boolean(reportId),
    staleTime: 60000,
  });
  const sourceReport = reportQuery.data?.interviewReport;
  let sourceNotice = null;
  if (sourceReport) {
    const hasResume = typeof sourceReport.resume === 'string' && sourceReport.resume.trim().length > 0;
    sourceNotice = hasResume
      ? 'Using the resume you uploaded for this plan. You do not need to upload it again.'
      : 'This plan has no uploaded resume, so the draft is built from your self-description only.';
  }

  const stepClass = (done, current) =>
    `verification-steps__item${done ? ' verification-steps__item--done' : ''}${current ? ' verification-steps__item--current' : ''}`;
  const exportReady = Boolean(grounded) && claims.length > 0;

  // Start verification handler
  const handleStartVerification = async () => {
    setIsStartingJob(true);
    setDraftError(null);
    setStartError(null);
    setPrintNotice(null);
    try {
      const data = await startVerificationJob(reportId, {
        githubAnalysisIds:
          githubLinks.verifiedAnalysisIds.length > 0 ? githubLinks.verifiedAnalysisIds : undefined,
      });
      if (data.jobId) {
        setActiveJobId(data.jobId);
      }
    } catch (err) {
      const body = err.response?.data;
      setStartError(
        body?.error?.message ||
          body?.message ||
          'Could not start verification. Check your connection and try again.'
      );
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
      setDraftNotice('Tailored resume draft generated. Run verification to check it before exporting.');
      queryClient.invalidateQueries({ queryKey: ['draft', reportId] });
      queryClient.invalidateQueries({ queryKey: ['githubLinks', reportId] }); // the draft's projects changed
      refetch();
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
    if (!printWindow) {
      setPrintNotice(
        'Your browser blocked the print preview pop-up. Allow pop-ups for this site and click Print / Save as PDF again.'
      );
      return;
    }
    printWindow.focus();
    setPrintNotice(
      'Print preview opened in a new tab. The page runs no scripts, so press Ctrl+P (Cmd+P on Mac) there and choose "Save as PDF".'
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
              The draft is a job-tailored rewrite of your resume. Each claim in it is then checked against the
              resume and self-description you provided, and only supported bullets reach the export. It confirms
              consistency with your own material; it does not independently verify facts.
            </p>
            {sourceNotice && (
              <p data-testid="resume-source-notice" style={{ marginTop: '0.25rem' }}>
                {sourceNotice}
              </p>
            )}
            <ol className="verification-steps" aria-label="Steps" data-testid="verification-steps" style={{ display: 'flex', gap: '1rem', listStyle: 'none', padding: 0, margin: '0.75rem 0 0 0', flexWrap: 'wrap' }}>
              <li className={stepClass(hasDraft, !hasDraft)} style={{ opacity: hasDraft ? 1 : 0.9 }}>
                {hasDraft ? '✓ ' : ''}1. Generate draft
              </li>
              <li className={stepClass(Boolean(run), hasDraft && !run)} style={{ opacity: hasDraft ? 1 : 0.5 }}>
                {run ? '✓ ' : ''}2. Verify claims
              </li>
              <li className={stepClass(exportReady, Boolean(run) && !exportReady)} style={{ opacity: run ? 1 : 0.5 }}>
                3. Export
              </li>
            </ol>
          </div>

          <div className="verification-page__header-actions" style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
            <button
              type="button"
              className="button secondary-button"
              onClick={handleGenerateDraft}
              disabled={isGeneratingDraft || activeJob.isRunning}
              title="Tailors your resume to this job using Gemini (costs 1 Gemini call)"
            >
              {isGeneratingDraft
                ? 'Generating Draft (Gemini)...'
                : hasDraft
                ? 'Regenerate Resume Draft'
                : '1. Generate Resume Draft'}
            </button>

            {!activeJob.isRunning && (
              <button
                type="button"
                className="button primary-button"
                onClick={handleStartVerification}
                disabled={isStartingJob || isGeneratingDraft || !canVerify}
                title={canVerify ? undefined : 'Generate the resume draft first (step 1)'}
              >
                {isStartingJob
                  ? 'Queueing Job...'
                  : claims.length > 0
                  ? 'Re-Run Verification'
                  : '2. Run Verification'}
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
        {startError && (
          <div className="verification-page__error-alert" role="alert">
            <strong>Verification Error: </strong>{startError}
          </div>
        )}

        {/* Newer draft than the verified one: export still uses the verified draft */}
        {grounded && grounded.isLatestDraftVerified === false && (
          <div className="verification-page__waking-alert" role="status" data-testid="stale-draft-notice">
            <span>
              You generated a newer draft after the last verification. Exports use the verified draft;
              run verification again to export the newer one.
            </span>
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
              Server is waking up (free hosting, up to a minute)... Please wait while instances initialize.
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

        {/* Result of the GitHub authorization redirect */}
        {githubResult && (
          <div
            role={githubResult.type === 'error' ? 'alert' : 'status'}
            className={githubResult.type === 'error' ? 'verification-page__error-alert' : 'verification-page__waking-alert'}
            data-testid="github-connect-result"
          >
            <span>{githubResult.message}</span>
          </div>
        )}

        {/* GitHub repository evidence: connect GitHub, pick a repository, then say which project it belongs to */}
        <GithubConnectPanel
          reportId={reportId}
          onAnalysisComplete={() => {
            queryClient.invalidateQueries({ queryKey: ['githubLinks', reportId] });
          }}
        />
        <ProjectRankingPanel reportId={reportId} />
        <GithubProjectLinks reportId={reportId} data={githubLinks.data} />

        {run?.config?.githubEvidence?.unmatchedAnalysisIds?.length > 0 && (
          <div className="verification-page__waking-alert" role="status" data-testid="unmatched-github-notice">
            <span>
              {run.config.githubEvidence.unmatchedAnalysisIds.length} linked repositor
              {run.config.githubEvidence.unmatchedAnalysisIds.length === 1 ? 'y' : 'ies'} did not match any project in
              the draft, so {run.config.githubEvidence.unmatchedAnalysisIds.length === 1 ? 'it was' : 'they were'} not
              used as evidence in this verification. Choose the project each repository belongs to above, then
              verify again.
            </span>
          </div>
        )}

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
              <h2>{hasDraft ? 'Ready to Verify' : 'No Draft Yet'}</h2>
              <p style={{ color: '#7d8590', maxWidth: '480px', margin: '0.5rem auto 1.5rem auto' }}>
                {hasDraft
                  ? 'Your tailored draft is ready. Run verification to check each claim before exporting.'
                  : 'Start by generating a job-tailored draft of your resume. Then run verification.'}{' '}
                Only bullets supported by your resume (or approved by you) are exported. Skills, education and
                contact details are exported only if they appear in your resume.
              </p>
              {hasDraft ? (
                <button
                  type="button"
                  className="button primary-button"
                  onClick={handleStartVerification}
                  disabled={isStartingJob || isGeneratingDraft}
                >
                  {isStartingJob ? 'Queueing Job...' : '2. Run Verification'}
                </button>
              ) : (
                <button
                  type="button"
                  className="button primary-button"
                  onClick={handleGenerateDraft}
                  disabled={isGeneratingDraft || draftQuery.isLoading}
                >
                  {isGeneratingDraft ? 'Generating Draft (Gemini)...' : '1. Generate Resume Draft'}
                </button>
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
}
