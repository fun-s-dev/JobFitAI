const pdfParse = require("pdf-parse")
const aiService = require("../services/ai.service")
const interviewReportModel = require("../models/interviewReport.model")
const { normalizeText } = require("../v2/core/normalizeText")
const { stripMarkdownLinks, extractResumeExtras } = require("../v2/core/resumeExtras")
const { LIMITS } = require("../v2/schemas/v1")
const { sendV1Error } = require("../v2/middlewares/v1Http")
const { UserDataError } = require("../v2/services/userData.service")
const { getUserDataService } = require("./auth.controller")


function deriveInterviewReportTitle(jobDescription, aiTitle) {
    const normalizedTitle = typeof aiTitle === "string" ? aiTitle.trim() : ""

    if (normalizedTitle) {
        return normalizedTitle
    }

    const meaningfulLine = (jobDescription || "")
        .split(/\r?\n/)
        .map(line => line.trim().replace(/^[-*•]\s*/, ""))
        .find(line => line.length > 0)

    return (meaningfulLine || "Interview Report").slice(0, 200)
}

/**
 * Extracts plain text (and the resume's links, certifications and grade lines) from an uploaded PDF buffer.
 * Throws ResumeError (with an HTTP status and user-facing message) for unreadable or empty PDFs.
 */
class ResumeError extends Error {
    constructor(status, code, message) {
        super(message)
        this.name = "ResumeError"
        this.status = status
        this.code = code
    }
}

async function extractResumeText(buffer) {
    let parser = null
    let rawText = ""
    try {
        parser = new pdfParse.PDFParse(Uint8Array.from(buffer))
        // Hyperlinks come back as Markdown [label](url); the labels alone are the normal resume text
        const parsed = await parser.getText({ parseHyperlinks: true })
        rawText = parsed && typeof parsed.text === "string" ? parsed.text : ""
    } catch {
        throw new ResumeError(
            422,
            "RESUME_UNREADABLE",
            "We could not read this PDF. It may be corrupted or password-protected. Please upload a different PDF or use the self description instead."
        )
    } finally {
        if (parser && typeof parser.destroy === "function") {
            await parser.destroy().catch(() => {})
        }
    }

    const text = normalizeText(stripMarkdownLinks(rawText))

    if (text.length < LIMITS.RESUME_TEXT_MIN) {
        throw new ResumeError(
            422,
            "RESUME_NO_TEXT",
            "No readable text was found in this PDF. Scanned or image-only resumes are not supported. Please upload a text-based PDF or use the self description instead."
        )
    }

    if (text.length > LIMITS.RESUME_TEXT_MAX) {
        throw new ResumeError(
            422,
            "RESUME_TOO_LONG",
            `This resume contains too much text (limit ${LIMITS.RESUME_TEXT_MAX} characters). Please upload a shorter version.`
        )
    }

    let extras = null
    try {
        extras = extractResumeExtras(rawText)
    } catch {
        extras = null // extras are a bonus; a parsing problem must never block the report
    }

    return { text, extras }
}

/**
 * Maps an upstream AI failure to a user-safe HTTP response. Raw SDK messages never reach the client.
 */
function respondToAiFailure(req, res, error) {
    const name = error && error.name

    if (name === "QuotaExhaustedError" || (error && error.code === "LLM_QUOTA_EXHAUSTED")) {
        return sendV1Error(
            req, res, 429, "LLM_QUOTA_EXHAUSTED",
            "The daily AI quota has been used up. Please try again tomorrow."
        )
    }

    if (name === "LlmValidationError") {
        return sendV1Error(
            req, res, 502, "AI_INVALID_RESPONSE",
            "The AI returned an incomplete answer. Please try again."
        )
    }

    const upstreamStatus = Number(error && (error.status || error.statusCode || error.upstreamStatus))
    const isUnavailable =
        name === "TimeoutError" ||
        name === "AbortError" ||
        name === "LlmClientError" ||
        [429, 500, 502, 503, 504].includes(upstreamStatus) ||
        /default credentials|api key|unavailable|timed out|timeout|network|econn|enotfound/i.test((error && error.message) || "")

    if (isUnavailable) {
        return sendV1Error(
            req, res, 503, "AI_UNAVAILABLE",
            "Interview report generation is temporarily unavailable. Please try again later."
        )
    }

    return sendV1Error(req, res, 500, "REPORT_GENERATION_FAILED", "Failed to generate the interview report.")
}


/**
 * @description Controller to generate interview report based on user self description, resume and job description.
 * Order matters: every cheap validation happens BEFORE the (quota-consuming) AI call.
 */
async function generateInterViewReportController(req, res) {
    const { selfDescription, jobDescription } = req.body // already validated and trimmed by validateV1

    if (!req.file && !selfDescription) {
        return sendV1Error(
            req, res, 400, "VALIDATION_ERROR",
            "Either a resume or a self description is required."
        )
    }

    let resumeText = ""
    let resumeExtras = null
    if (req.file) {
        try {
            const extracted = await extractResumeText(req.file.buffer)
            resumeText = extracted.text
            resumeExtras = extracted.extras
        } catch (error) {
            if (error instanceof ResumeError) {
                return sendV1Error(req, res, error.status, error.code, error.message)
            }
            throw error
        }
    }

    let aiReport
    try {
        aiReport = await aiService.generateInterviewReport({
            resume: resumeText,
            selfDescription,
            jobDescription,
            user: String(req.user.id),
            requestId: req.id,
        })
    } catch (error) {
        if (req.log && typeof req.log.error === "function") {
            req.log.error({ errName: error && error.name, errMessage: error && error.message }, "Interview report AI call failed")
        }
        return respondToAiFailure(req, res, error)
    }

    // Persist only the validated, whitelisted fields (never spread unvalidated model output)
    const interviewReport = await interviewReportModel.create({
        user: req.user.id,
        resume: resumeText,
        resumeExtras,
        selfDescription,
        jobDescription,
        matchScore: aiReport.matchScore,
        technicalQuestions: aiReport.technicalQuestions,
        behavioralQuestions: aiReport.behavioralQuestions,
        skillGaps: aiReport.skillGaps,
        preparationPlan: aiReport.preparationPlan,
        title: deriveInterviewReportTitle(jobDescription, aiReport.title)
    })

    return res.status(201).json({
        message: "Interview report generated successfully.",
        interviewReport
    })
}

/**
 * @description Controller to get interview report by interviewId. The id was validated by validateV1.
 */
async function getInterviewReportByIdController(req, res) {

    const { interviewId } = req.params

    const interviewReport = await interviewReportModel.findOne({ _id: interviewId, user: req.user.id })

    if (!interviewReport) {
        return sendV1Error(req, res, 404, "NOT_FOUND", "Interview report not found.")
    }

    res.status(200).json({
        message: "Interview report fetched successfully.",
        interviewReport
    })
}


/** 
 * @description Controller to get all interview reports of logged in user.
 */
async function getAllInterviewReportsController(req, res) {
    const interviewReports = await interviewReportModel
        .find({ user: req.user.id })
        .sort({ createdAt: -1 })
        .limit(100)
        .select("-resume -resumeExtras -selfDescription -jobDescription -__v -technicalQuestions -behavioralQuestions -skillGaps -preparationPlan")

    res.status(200).json({
        message: "Interview reports fetched successfully.",
        interviewReports
    })
}


/**
 * @description Permanently deletes one report with its drafts, verification runs, claims, jobs and
 * repository links. 404 when the report is not the caller's; 409 while a job for it is still running.
 */
async function deleteInterviewReportController(req, res) {
    const { interviewId } = req.params

    try {
        const result = await getUserDataService().deleteReport({ reportId: interviewId, userId: req.user.id })
        return res.status(200).json({ message: "Interview report deleted.", ...result })
    } catch (error) {
        if (error instanceof UserDataError) {
            return sendV1Error(req, res, error.status, error.code, error.message)
        }
        throw error
    }
}


/**
 * @description Controller to generate resume PDF based on user self description, resume and job description.
 * LEGACY: scheduled for removal once the V2 grounded export is verified in a browser.
 */
async function generateResumePdfController(req, res) {
    const { interviewReportId } = req.params

    const interviewReport = await interviewReportModel.findOne({ _id: interviewReportId, user: req.user.id })

    if (!interviewReport) {
        return sendV1Error(req, res, 404, "NOT_FOUND", "Interview report not found.")
    }

    const { resume, jobDescription, selfDescription } = interviewReport

    let pdfBuffer
    try {
        pdfBuffer = await aiService.generateResumePdf({ resume, jobDescription, selfDescription })
    } catch (error) {
        if (req.log && typeof req.log.error === "function") {
            req.log.error({ errName: error && error.name, errMessage: error && error.message }, "Legacy resume PDF generation failed")
        }
        return respondToAiFailure(req, res, error)
    }

    res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename=resume_${interviewReportId}.pdf`
    })

    res.send(pdfBuffer)
}

module.exports = { generateInterViewReportController, getInterviewReportByIdController, getAllInterviewReportsController, deleteInterviewReportController, generateResumePdfController }
