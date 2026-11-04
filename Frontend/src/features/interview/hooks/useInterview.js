import { getAllInterviewReports, generateInterviewReport, getInterviewReportById, generateResumePdf, deleteInterviewReport, deleteAccount } from "../services/interview.api"
import { useContext, useEffect } from "react"
import { InterviewContext } from "../interview.context"
import { useParams } from "react-router"
import { getApiErrorMessage } from "../../../services/apiError"


export const useInterview = () => {

    const context = useContext(InterviewContext)
    const { interviewId } = useParams()

    if (!context) {
        throw new Error("useInterview must be used within an InterviewProvider")
    }

    const { loading, setLoading, generating, setGenerating, report, setReport, reports, setReports, error, setError } = context

    /** Creates a report. Returns the report, or null after setting `error` to a user-facing message. */
    const generateReport = async ({ jobDescription, selfDescription, resumeFile }) => {
        setGenerating(true)
        setError(null)
        let response = null
        try {
            response = await generateInterviewReport({ jobDescription, selfDescription, resumeFile })
            setReport(response?.interviewReport ?? null)
        } catch (err) {
            setError(getApiErrorMessage(err, "We could not generate your interview plan. Please try again."))
        } finally {
            setGenerating(false)
        }

        return response?.interviewReport ?? null
    }

    const getReportById = async (interviewId) => {
        setLoading(true)
        setError(null)
        setReport(null) // never show the previously opened report while a new one loads or fails
        let response = null
        try {
            response = await getInterviewReportById(interviewId)
            setReport(response?.interviewReport ?? null)
        } catch (err) {
            setError(
                err?.response?.status === 404
                    ? "This interview plan was not found. It may have been removed."
                    : getApiErrorMessage(err, "We could not load this interview plan.")
            )
        } finally {
            setLoading(false)
        }
        return response?.interviewReport ?? null
    }

    const getReports = async () => {
        setLoading(true)
        setError(null)
        let response = null
        try {
            response = await getAllInterviewReports()
            setReports(response?.interviewReports ?? [])
        } catch (err) {
            setError(getApiErrorMessage(err, "We could not load your previous interview plans."))
        } finally {
            setLoading(false)
        }

        return response?.interviewReports ?? []
    }

    /** Permanently deletes a report. Returns true on success; otherwise sets `error` and returns false. */
    const removeReport = async (interviewId) => {
        setError(null)
        try {
            await deleteInterviewReport(interviewId)
            setReports((current) => current.filter((r) => r._id !== interviewId))
            return true
        } catch (err) {
            setError(getApiErrorMessage(err, "We could not delete this interview plan."))
            return false
        }
    }

    /** Permanently deletes the account. Returns true on success; otherwise sets `error` and returns false. */
    const removeAccount = async (password) => {
        setError(null)
        try {
            await deleteAccount({ password })
            return true
        } catch (err) {
            setError(getApiErrorMessage(err, "We could not delete your account."))
            return false
        }
    }

    // LEGACY (removed with the backend route): download of the ungrounded V1 resume PDF.
    // Does not use the page-wide loading flag, so the report stays visible; failures set `error`.
    const getResumePdf = async (interviewReportId) => {
        setError(null)
        try {
            const blob = await generateResumePdf({ interviewReportId })
            const url = window.URL.createObjectURL(new Blob([ blob ], { type: "application/pdf" }))
            const link = document.createElement("a")
            link.href = url
            link.setAttribute("download", `resume_${interviewReportId}.pdf`)
            document.body.appendChild(link)
            link.click()
            link.remove()
            window.URL.revokeObjectURL(url)
        } catch (err) {
            setError(getApiErrorMessage(err, "We could not create the PDF. Please try again."))
        }
    }

    useEffect(() => {
        if (interviewId) {
            getReportById(interviewId)
        } else {
            getReports()
        }
    }, [ interviewId ])

    return { loading, generating, error, report, reports, generateReport, getReportById, getReports, removeReport, removeAccount, getResumePdf }

}
