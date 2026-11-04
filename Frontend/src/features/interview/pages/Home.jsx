import React, { useState, useRef, useEffect, useContext } from 'react'
import "../style/interview.scss"
import { useInterview } from '../hooks/useInterview.js'
import { useNavigate } from 'react-router'
import { validateReportInput, REPORT_LIMITS } from '../utils/validateReportInput.js'
import { AuthContext } from '../../auth/auth.context.jsx'

const Home = () => {

    const { generating, error, generateReport, reports, removeReport, removeAccount } = useInterview()
    const authContext = useContext(AuthContext)
    const [ deletePassword, setDeletePassword ] = useState("")
    const [ isDeletingAccount, setIsDeletingAccount ] = useState(false)
    const [ jobDescription, setJobDescription ] = useState("")
    const [ selfDescription, setSelfDescription ] = useState("")
    const [ resumeFile, setResumeFile ] = useState(null)
    const [ fieldErrors, setFieldErrors ] = useState({})
    const [ isWakingUp, setIsWakingUp ] = useState(false)
    const resumeInputRef = useRef()
    const navigate = useNavigate()

    useEffect(() => {
        let timer;
        if (generating) {
            timer = setTimeout(() => {
                setIsWakingUp(true);
            }, 3000);
        } else {
            setIsWakingUp(false);
        }
        return () => clearTimeout(timer);
    }, [generating]);

    const handleFileChange = (e) => {
        const file = e.target.files && e.target.files[0] ? e.target.files[0] : null
        setResumeFile(file)
        setFieldErrors((prev) => ({ ...prev, resume: undefined, profile: undefined }))
    }

    const handleRemoveFile = (e) => {
        e.preventDefault()
        e.stopPropagation()
        setResumeFile(null)
        if (resumeInputRef.current) {
            resumeInputRef.current.value = ""
        }
    }

    const handleGenerateReport = async () => {
        if (generating) {
            return
        }

        const { valid, errors } = validateReportInput({ jobDescription, selfDescription, resumeFile })
        setFieldErrors(errors)
        if (!valid) {
            return
        }

        const data = await generateReport({ jobDescription, selfDescription, resumeFile })
        if (!data?._id) {
            return
        }
        navigate(`/interview/${data._id}`)
    }

    const handleDeleteReport = async (e, report) => {
        e.stopPropagation()
        const confirmed = window.confirm(
            `Delete "${report.title || 'this interview plan'}" permanently? This also removes its resume text, drafts and verification results.`
        )
        if (confirmed) {
            await removeReport(report._id)
        }
    }

    const handleDeleteAccount = async (e) => {
        e.preventDefault()
        if (!deletePassword || isDeletingAccount) {
            return
        }
        const confirmed = window.confirm(
            'Permanently delete your account and ALL of your data (plans, resume text, drafts, verification results, GitHub connection)? This cannot be undone.'
        )
        if (!confirmed) {
            return
        }
        setIsDeletingAccount(true)
        const deleted = await removeAccount(deletePassword)
        setIsDeletingAccount(false)
        setDeletePassword("")
        if (deleted && authContext && typeof authContext.setUser === 'function') {
            // The session is already ended server-side; clearing the user sends the app to the login page
            authContext.setUser(null)
        }
    }

    if (generating) {
        return (
            <main className='loading-screen'>
                <h1>Building your interview plan...</h1>
                <p style={{ marginTop: '1rem', color: '#888', fontSize: '0.95rem' }}>
                    This usually takes up to 30 seconds. Please keep this page open.
                </p>
                {isWakingUp && (
                    <p style={{ marginTop: '1rem', color: '#888', fontSize: '0.95rem' }}>
                        Server is waking up (free hosting, up to a minute)... Please wait while instances initialize.
                    </p>
                )}
            </main>
        )
    }

    return (
        <div className='home-page'>

            {/* Page Header */}
            <header className='page-header'>
                <h1>Create Your Custom <span className='highlight'>Interview Plan</span></h1>
                <p>Let our AI analyze the job requirements and your unique profile to build a winning strategy.</p>
            </header>

            {/* Server / generation error */}
            {error && (
                <div role='alert' className='form-error form-error--banner' style={{ color: '#ff6b6b', margin: '0 0 1rem 0' }}>
                    {error}
                </div>
            )}

            {/* Main Card */}
            <div className='interview-card'>
                <div className='interview-card__body'>

                    {/* Left Panel - Job Description */}
                    <div className='panel panel--left'>
                        <div className='panel__header'>
                            <span className='panel__icon'>
                                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2" /><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" /></svg>
                            </span>
                            <h2>Target Job Description</h2>
                            <span className='badge badge--required'>Required</span>
                        </div>
                        <textarea
                            value={jobDescription}
                            onChange={(e) => { setJobDescription(e.target.value); setFieldErrors((prev) => ({ ...prev, jobDescription: undefined })) }}
                            className='panel__textarea'
                            aria-label='Target job description'
                            placeholder={`Paste the full job description here...\ne.g. 'Senior Frontend Engineer at Google requires proficiency in React, TypeScript, and large-scale system design...'`}
                            maxLength={REPORT_LIMITS.JOB_DESCRIPTION_MAX}
                        />
                        <div className='char-counter'>{jobDescription.length} / {REPORT_LIMITS.JOB_DESCRIPTION_MAX} chars</div>
                        {fieldErrors.jobDescription && (
                            <p role='alert' className='form-error' style={{ color: '#ff6b6b', fontSize: '0.85rem', margin: '0.25rem 0 0 0' }}>{fieldErrors.jobDescription}</p>
                        )}
                    </div>

                    {/* Vertical Divider */}
                    <div className='panel-divider' />

                    {/* Right Panel - Profile */}
                    <div className='panel panel--right'>
                        <div className='panel__header'>
                            <span className='panel__icon'>
                                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
                            </span>
                            <h2>Your Profile</h2>
                        </div>

                        {/* Upload Resume */}
                        <div className='upload-section'>
                            <label className='section-label'>
                                Upload Resume
                                <span className='badge badge--best'>Best Results</span>
                            </label>
                            <label className='dropzone' htmlFor='resume'>
                                <span className='dropzone__icon'>
                                    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 16 12 12 8 16" /><line x1="12" y1="12" x2="12" y2="21" /><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" /></svg>
                                </span>
                                <p className='dropzone__title' id='dropzone-file-name'>
                                    {resumeFile ? `Selected: ${resumeFile.name}` : 'Click to upload or drag & drop'}
                                </p>
                                <p className='dropzone__subtitle'>{resumeFile ? 'PDF attached' : 'PDF only (Max 3MB)'}</p>
                                <input
                                    ref={resumeInputRef}
                                    hidden
                                    type='file'
                                    id='resume'
                                    name='resume'
                                    accept='.pdf,application/pdf'
                                    onChange={handleFileChange}
                                />
                            </label>
                            {resumeFile && (
                                <button type='button' onClick={handleRemoveFile} className='button secondary-button' style={{ marginTop: '0.5rem' }}>
                                    Remove file
                                </button>
                            )}
                            {fieldErrors.resume && (
                                <p role='alert' className='form-error' style={{ color: '#ff6b6b', fontSize: '0.85rem', margin: '0.25rem 0 0 0' }}>{fieldErrors.resume}</p>
                            )}
                        </div>

                        {/* OR Divider */}
                        <div className='or-divider'><span>OR</span></div>

                        {/* Quick Self-Description */}
                        <div className='self-description'>
                            <label className='section-label' htmlFor='selfDescription'>Quick Self-Description</label>
                            <textarea
                                value={selfDescription}
                                onChange={(e) => { setSelfDescription(e.target.value); setFieldErrors((prev) => ({ ...prev, profile: undefined })) }}
                                id='selfDescription'
                                name='selfDescription'
                                className='panel__textarea panel__textarea--short'
                                placeholder="Briefly describe your experience, key skills, and years of experience if you don't have a resume handy..."
                            />
                            {fieldErrors.profile && (
                                <p role='alert' className='form-error' style={{ color: '#ff6b6b', fontSize: '0.85rem', margin: '0.25rem 0 0 0' }}>{fieldErrors.profile}</p>
                            )}
                        </div>

                        {/* Info Box */}
                        <div className='info-box'>
                            <span className='info-box__icon'>
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" stroke="#1a1f27" strokeWidth="2" /><line x1="12" y1="16" x2="12.01" y2="16" stroke="#1a1f27" strokeWidth="2" /></svg>
                            </span>
                            <p>Either a <strong>Resume</strong> or a <strong>Self Description</strong> is required to generate a personalized plan.</p>
                        </div>
                    </div>
                </div>

                {/* Card Footer */}
                <div className='interview-card__footer'>
                    <span className='footer-info'>AI-Powered Strategy Generation &bull; Approx 30s</span>
                    <button
                        onClick={handleGenerateReport}
                        disabled={generating}
                        className='generate-btn'>
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z" /></svg>
                        Generate My Interview Strategy
                    </button>
                </div>
            </div>

            {/* Recent Reports List */}
            {reports.length > 0 && (
                <section className='recent-reports'>
                    <h2>My Recent Interview Plans</h2>
                    <ul className='reports-list'>
                        {reports.map(report => (
                            <li key={report._id} className='report-item' onClick={() => navigate(`/interview/${report._id}`)}>
                                <h3>{report.title || 'Untitled Position'}</h3>
                                <p className='report-meta'>Generated on {new Date(report.createdAt).toLocaleDateString()}</p>
                                <p className={`match-score ${report.matchScore >= 80 ? 'score--high' : report.matchScore >= 60 ? 'score--mid' : 'score--low'}`}>Match Score: {report.matchScore}%</p>
                                <button
                                    type='button'
                                    className='button secondary-button'
                                    aria-label={`Delete ${report.title || 'interview plan'}`}
                                    onClick={(e) => handleDeleteReport(e, report)}
                                >
                                    Delete
                                </button>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {/* Privacy: delete account and all data */}
            <details className='account-deletion' style={{ margin: '1.5rem 0' }}>
                <summary>Delete my account and data</summary>
                <form onSubmit={handleDeleteAccount} style={{ marginTop: '0.75rem' }}>
                    <p style={{ fontSize: '0.85rem', color: '#9aa4b2' }}>
                        This permanently removes your plans, resume text, drafts, verification results and GitHub
                        connection. Enter your password to confirm.
                    </p>
                    <input
                        type='password'
                        value={deletePassword}
                        onChange={(e) => setDeletePassword(e.target.value)}
                        placeholder='Your password'
                        aria-label='Password to confirm account deletion'
                        autoComplete='current-password'
                    />{' '}
                    <button type='submit' className='button secondary-button' disabled={!deletePassword || isDeletingAccount}>
                        {isDeletingAccount ? 'Deleting…' : 'Delete my account'}
                    </button>
                </form>
            </details>

            {/* Page Footer */}
            <footer className='page-footer'>
                <span>JobFitAI · AI-Assisted Resume Tailoring &amp; Consistency Checking</span>
            </footer>
        </div>
    )
}

export default Home
