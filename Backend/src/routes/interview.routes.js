const express = require("express")
const authMiddleware = require("../middlewares/auth.middleware")
const interviewController = require("../controllers/interview.controller")
const upload = require("../middlewares/file.middleware")
const { getCfg } = require("../v2/config/env")
const { createRateLimiter } = require("../v2/middlewares/rateLimits")
const { guardLlmGenerationBudget, guardUserDailyReports } = require("../v2/middlewares/budgetGuard")
const { validateV1, createInFlightLimiter } = require("../v2/middlewares/v1Http")
const { createReportBodySchema, reportIdParamsSchema, pdfReportIdParamsSchema } = require("../v2/schemas/v1")

const interviewRouter = express.Router()
const cfg = getCfg()

// Every route that calls Gemini is limited per user, capped per day, and runs one at a time per user.
const reportLimiter = createRateLimiter({
    windowMs: cfg.RATE_LIMIT_REPORT_WINDOW_MS,
    max: cfg.RATE_LIMIT_REPORT_MAX,
    message: "Too many report requests, please try again later",
})
const reportInFlight = createInFlightLimiter({
    message: "Your previous report is still being generated. Please wait for it to finish.",
})
const pdfLimiter = createRateLimiter({
    windowMs: cfg.RATE_LIMIT_EXPORT_WINDOW_MS,
    max: cfg.RATE_LIMIT_EXPORT_MAX,
    message: "Too many PDF requests, please try again later",
})

/**
 * @route POST /api/interview/
 * @description generate new interview report on the basis of user self description,resume pdf and job description.
 * @access private
 */
interviewRouter.post(
    "/",
    authMiddleware.authUser,
    reportLimiter,
    guardUserDailyReports,
    guardLlmGenerationBudget,
    reportInFlight,
    upload.single("resume"),
    validateV1({ body: createReportBodySchema }),
    interviewController.generateInterViewReportController
)

/**
 * @route GET /api/interview/report/:interviewId
 * @description get interview report by interviewId.
 * @access private
 */
interviewRouter.get(
    "/report/:interviewId",
    authMiddleware.authUser,
    validateV1({ params: reportIdParamsSchema }),
    interviewController.getInterviewReportByIdController
)


/**
 * @route DELETE /api/interview/report/:interviewId
 * @description permanently delete a report and everything derived from it (drafts, claims, runs, jobs, links).
 * @access private
 */
interviewRouter.delete(
    "/report/:interviewId",
    authMiddleware.authUser,
    validateV1({ params: reportIdParamsSchema }),
    interviewController.deleteInterviewReportController
)


/**
 * @route GET /api/interview/
 * @description get all interview reports of logged in user.
 * @access private
 */
interviewRouter.get("/", authMiddleware.authUser, interviewController.getAllInterviewReportsController)


/**
 * @route POST /api/interview/resume/pdf/:interviewReportId
 * @description LEGACY (scheduled for removal): generate resume pdf from the stored report.
 * Rate limited and budget guarded in the meantime because it still calls Gemini directly.
 * @access private
 */
interviewRouter.post(
    "/resume/pdf/:interviewReportId",
    authMiddleware.authUser,
    pdfLimiter,
    guardLlmGenerationBudget,
    validateV1({ params: pdfReportIdParamsSchema }),
    interviewController.generateResumePdfController
)



module.exports = interviewRouter
