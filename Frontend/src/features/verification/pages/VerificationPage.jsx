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
      const created = await createDraftForReport(reportId);
      const gh = created?.githubProjects;
      const parts = ['Tailored resume draft generated.'];
      if (gh?.used?.length > 0) {
        parts.push(
          `Your Projects section was written from ${gh.used.length} GitHub project${gh.used.length === 1 ? '' : 's'}: ${gh.used
            .map((p) => p.name)
            .join(', ')}. Confirm that you built each one below so it is included in your export.`
        );
      }
      if (gh?.skipped?.length > 0) parts.push(gh.skipped.map((s) => s.reason).join(' '));
      if (gh?.error) {
        parts.push(
          `GitHub projects could not be written (${gh.error}), so your resume's own projects were kept. Generate the draft again to retry.`
        );
      }
      if (!gh?.error) parts.push('Run verification to check it before exporting.');
      setDraftNotice(parts.join(' '));
      queryClient.invalidateQueries({ queryKey: ['draft', reportId] });
      queryClient.invalidateQueries({ queryKey: ['githubLinks', reportId] }); // the draft's projects changed
      queryClient.invalidateQueries({ queryKey: ['repoRanking', reportId] });
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

  // ── What the user sees: four steps, each with a clear state ───────────────────────────────────
  const githubProjectCount = (githubLinks.data?.links || []).filter((l) => l.verified && l.selected).length;
  const draftOutdated = Boolean(githubLinks.data?.draftOutdated);
  const projectsDone = githubProjectCount > 0;
  const draftDone = hasDraft && !draftOutdated;
  const verifyDone = Boolean(run);
  const steps = [
    { key: 'projects', label: 'Choose projects', hint: projectsDone ? `${githubProjectCount} from GitHub` : 'From GitHub, optional', done: projectsDone, current: !projectsDone && !hasDraft },
    { key: 'draft', label: 'Generate draft', hint: draftOutdated ? 'Out of date' : hasDraft ? 'Ready' : 'Tailored to the job', done: draftDone, current: (!hasDraft && projectsDone) || draftOutdated },
    { key: 'verify', label: 'Verify claims', hint: verifyDone ? `${claims.length} claims checked` : 'Check every claim', done: verifyDone, current: draftDone && !verifyDone },
    { key: 'export', label: 'Export', hint: 'Print or PDF', done: exportReady, current: verifyDone && !exportReady },
  ];

  const unmatchedCount = run?.config?.githubEvidence?.unmatchedAnalysisIds?.length || 0;

  return (
    <div className="verification-page">
      <div className="verification-page__layout">
        {/* Hero */}
        <header className="vp-hero">
          <Link to={`/interview/${reportId}`} className="vp-hero__back">
            &larr; Back to Interview Prep
          </Link>
          <h1 className="vp-hero__title">Resume Verification & Grounded Export</h1>
          <p className="vp-hero__lede">
            The draft is a job-tailored rewrite of your resume. Each claim in it is then checked against the
            resume and self-description you provided, and only supported bullets reach the export. It confirms
            consistency with your own material; it does not independently verify facts.
          </p>
          {sourceNotice && (
            <p className="vp-hero__source" data-testid="resume-source-notice">
              {sourceNotice}
            </p>
          )}
        </header>

        {/* Progress */}
        <ol className="vp-steps" aria-label="Steps" data-testid="verification-steps">
          {steps.map((s, i) => (
            <li
              key={s.key}
              className={`vp-step${s.done ? ' vp-step--done' : ''}${s.current ? ' vp-step--current' : ''}`}
              aria-current={s.current ? 'step' : undefined}
            >
              <span className="vp-step__num" aria-hidden="true">{s.done ? '✓' : i + 1}</span>
              <span className="vp-step__text">
                <span className="vp-step__label">{i + 1}. {s.label}</span>
                <span className="vp-step__hint">{s.hint}</span>
              </span>
            </li>
          ))}
        </ol>

        {/* Alerts that apply to the whole page */}
        {isWakingUp && (
          <div className="vp-alert vp-alert--warning" role="status">
            <span className="vp-alert__icon" aria-hidden="true">⏱</span>
            <span className="vp-alert__body">
              Server is waking up (free hosting, up to a minute)... Please wait while instances initialize.
            </span>
          </div>
        )}
        {githubResult && (
          <div
            role={githubResult.type === 'error' ? 'alert' : 'status'}
            className={`vp-alert vp-alert--${githubResult.type === 'error' ? 'error' : 'success'}`}
            data-testid="github-connect-result"
          >
            <span className="vp-alert__icon" aria-hidden="true">{githubResult.type === 'error' ? '⚠' : '✓'}</span>
            <span className="vp-alert__body">{githubResult.message}</span>
          </div>
        )}

        {/* Step 1: GitHub projects */}
        <section className="vp-panel" aria-label="GitHub projects">
          <div className="vp-panel__head">
            <div>
              <h2 className="vp-panel__title">
                <span className="vp-panel__num">1</span>Your projects from GitHub
                <span className="vp-panel__badge">Optional</span>
              </h2>
              <p className="vp-panel__desc">
                Connect GitHub and the app finds the repositories that best fit this job. Your Projects section is
                then written from those repositories, and each project is checked against its own repository.
              </p>
            </div>
          </div>
          <GithubConnectPanel
            reportId={reportId}
            onAnalysisComplete={() => {
              queryClient.invalidateQueries({ queryKey: ['githubLinks', reportId] });
            }}
          />
          <ProjectRankingPanel reportId={reportId} />
          <GithubProjectLinks reportId={reportId} data={githubLinks.data} />
        </section>

        {/* Steps 2 and 3: draft and verification */}
        <section className="vp-panel" aria-label="Draft and verification">
          <div className="vp-panel__head">
            <div>
              <h2 className="vp-panel__title">
                <span className="vp-panel__num">2</span>Build and check your resume
              </h2>
              <p className="vp-panel__desc">
                Generating the draft costs 1 Gemini call (plus 1 per GitHub project). Verification checks every claim
                with embeddings and entailment. Confidence is a ranking score, not a probability.
              </p>
            </div>
          </div>

          {draftOutdated && (
            <div className="vp-alert vp-alert--warning" role="status" data-testid="draft-outdated-notice">
              <span className="vp-alert__icon" aria-hidden="true">⚠</span>
              <span className="vp-alert__body">
                Your draft was made before you chose your GitHub projects, so it does not use them yet. Generate the
                draft again to write your Projects section from them.
              </span>
            </div>
          )}

          <div className="action-grid">
            <div className="action-tile">
              <div className="action-tile__top">
                <span className="vp-panel__num">2</span>
                <span className="action-tile__title">Generate resume draft</span>
              </div>
              <p className="action-tile__desc">
                A job-tailored rewrite of your resume. Nothing is added that your evidence does not support.
                {githubProjectCount > 0
                  ? ` Your Projects section comes from your ${githubProjectCount} selected GitHub project${githubProjectCount === 1 ? '' : 's'}.`
                  : ''}
              </p>
              <div className="action-tile__foot">
                <button
                  type="button"
                  className={`vp-btn ${hasDraft && !draftOutdated ? 'vp-btn--secondary' : 'vp-btn--primary'}`}
                  onClick={handleGenerateDraft}
                  disabled={isGeneratingDraft || activeJob.isRunning}
                  title="Tailors your resume to this job using Gemini (costs 1 Gemini call)"
                >
                  {isGeneratingDraft && <span className="vp-spinner" aria-hidden="true" />}
                  {isGeneratingDraft
                    ? 'Generating Draft (Gemini)...'
                    : hasDraft
                    ? 'Regenerate Resume Draft'
                    : '2. Generate Resume Draft'}
                </button>
              </div>
            </div>

            <div className={`action-tile${canVerify ? '' : ' action-tile--locked'}`}>
              <div className="action-tile__top">
                <span className="vp-panel__num">3</span>
                <span className="action-tile__title">Verify every claim</span>
              </div>
              <p className="action-tile__desc">
                Each bullet is split into small claims and checked against your resume
                {githubProjectCount > 0 ? ' (and, for GitHub projects, against that repository)' : ''}. Only claims that
                hold up are exported.
              </p>
              <div className="action-tile__foot">
                {!activeJob.isRunning && (
                  <button
                    type="button"
                    className={`vp-btn ${draftDone && !verifyDone ? 'vp-btn--primary' : 'vp-btn--secondary'}`}
                    onClick={handleStartVerification}
                    disabled={isStartingJob || isGeneratingDraft || !canVerify}
                    title={canVerify ? undefined : 'Generate the resume draft first (step 2)'}
                  >
                    {isStartingJob
                      ? 'Queueing Job...'
                      : claims.length > 0
                      ? 'Re-Run Verification'
                      : '3. Run Verification'}
                  </button>
                )}
                {!canVerify && <span className="action-tile__meta">Generate the draft first.</span>}
              </div>
            </div>
          </div>

          {draftNotice && (
            <div className="vp-alert vp-alert--success" role="status">
              <span className="vp-alert__icon" aria-hidden="true">✓</span>
              <span className="vp-alert__body">{draftNotice}</span>
            </div>
          )}
          {draftError && (
            <div className="vp-alert vp-alert--error" role="alert">
              <span className="vp-alert__icon" aria-hidden="true">⚠</span>
              <span className="vp-alert__body"><strong>Draft Error: </strong>{draftError}</span>
            </div>
          )}
          {startError && (
            <div className="vp-alert vp-alert--error" role="alert">
              <span className="vp-alert__icon" aria-hidden="true">⚠</span>
              <span className="vp-alert__body"><strong>Verification Error: </strong>{startError}</span>
            </div>
          )}
          {(isVerifyingError || activeJob.isFailed) && (
            <div className="vp-alert vp-alert--error" role="alert">
              <span className="vp-alert__icon" aria-hidden="true">⚠</span>
              <span className="vp-alert__body">
                <strong>Verification Notice: </strong>
                {activeJob.error?.message ||
                  verifyError?.response?.data?.error?.message ||
                  'Unable to load or run verification at this time. Please check your connection.'}
              </span>
            </div>
          )}
          {grounded && grounded.isLatestDraftVerified === false && (
            <div className="vp-alert vp-alert--info" role="status" data-testid="stale-draft-notice">
              <span className="vp-alert__icon" aria-hidden="true">ℹ</span>
              <span className="vp-alert__body">
                You generated a newer draft after the last verification. Exports use the verified draft;
                run verification again to export the newer one.
              </span>
            </div>
          )}
          {unmatchedCount > 0 && (
            <div className="vp-alert vp-alert--warning" role="status" data-testid="unmatched-github-notice">
              <span className="vp-alert__icon" aria-hidden="true">⚠</span>
              <span className="vp-alert__body">
                {unmatchedCount} linked repositor{unmatchedCount === 1 ? 'y' : 'ies'} did not match any project in
                the draft, so {unmatchedCount === 1 ? 'it was' : 'they were'} not used as evidence in this
                verification. Choose the project each repository belongs to above, then verify again.
              </span>
            </div>
          )}
        </section>

        {printNotice && (
          <div className="vp-alert vp-alert--info" role="status">
            <span className="vp-alert__icon" aria-hidden="true">🖨</span>
            <span className="vp-alert__body">{printNotice}</span>
          </div>
        )}

        {isVerifyingLoading && !isWakingUp && (
          <div className="loading-screen" style={{ minHeight: '120px' }}>
            <p>Loading verification audit records...</p>
          </div>
        )}

        {/* Results and export (step 4) */}
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

        {claims.length > 0 && (
          <div className="filter-bar" role="toolbar" aria-label="Filter claims by status">
            {[
              ['all', `All Claims (${claims.length})`],
              ['needs_review', 'Needs Review'],
              ['verified', 'Verified / Approved'],
              ['rejected', 'Rejected'],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`filter-bar__btn ${filterStatus === key ? 'filter-bar__btn--active' : ''}`}
                onClick={() => setFilterStatus(key)}
              >
                {label}
              </button>
            ))}
          </div>
        )}

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
            <div className="vp-empty">
              <h2>{hasDraft ? 'Ready to Verify' : 'No Draft Yet'}</h2>
              <p>
                {hasDraft
                  ? 'Your tailored draft is ready. Run verification to check each claim before exporting.'
                  : 'Start by generating a job-tailored draft of your resume. Then run verification.'}{' '}
                Only bullets supported by your resume (or approved by you) are exported. Skills, education and
                contact details are exported only if they appear in your resume.
              </p>
              {hasDraft ? (
                <button
                  type="button"
                  className="vp-btn vp-btn--primary"
                  onClick={handleStartVerification}
                  disabled={isStartingJob || isGeneratingDraft}
                >
                  {isStartingJob ? 'Queueing Job...' : '3. Run Verification'}
                </button>
              ) : (
                <button
                  type="button"
                  className="vp-btn vp-btn--primary"
                  onClick={handleGenerateDraft}
                  disabled={isGeneratingDraft || draftQuery.isLoading}
                >
                  {isGeneratingDraft ? 'Generating Draft (Gemini)...' : '2. Generate Resume Draft'}
                </button>
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
}
