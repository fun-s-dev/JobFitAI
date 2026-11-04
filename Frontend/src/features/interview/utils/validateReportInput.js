// Mirrors the backend limits in Backend/src/v2/schemas/v1.js (the backend remains the authority).
export const REPORT_LIMITS = Object.freeze({
  JOB_DESCRIPTION_MIN: 20,
  JOB_DESCRIPTION_MAX: 5000,
  SELF_DESCRIPTION_MAX: 5000,
  RESUME_MAX_BYTES: 3 * 1024 * 1024,
});

/**
 * Validates the Home form before any request is sent.
 *
 * @param {{ jobDescription: string, selfDescription: string, resumeFile: File|null }} input
 * @returns {{ valid: boolean, errors: { jobDescription?: string, profile?: string, resume?: string } }}
 */
export function validateReportInput({ jobDescription = '', selfDescription = '', resumeFile = null } = {}) {
  const errors = {};
  const job = jobDescription.trim();
  const self = selfDescription.trim();

  if (job.length < REPORT_LIMITS.JOB_DESCRIPTION_MIN) {
    errors.jobDescription = `Paste the job description (at least ${REPORT_LIMITS.JOB_DESCRIPTION_MIN} characters).`;
  } else if (job.length > REPORT_LIMITS.JOB_DESCRIPTION_MAX) {
    errors.jobDescription = `The job description must be at most ${REPORT_LIMITS.JOB_DESCRIPTION_MAX} characters.`;
  }

  if (self.length > REPORT_LIMITS.SELF_DESCRIPTION_MAX) {
    errors.profile = `The self description must be at most ${REPORT_LIMITS.SELF_DESCRIPTION_MAX} characters.`;
  }

  if (resumeFile) {
    const looksLikePdf = resumeFile.type === 'application/pdf' || /\.pdf$/i.test(resumeFile.name || '');
    if (!looksLikePdf) {
      errors.resume = 'Only PDF files are supported.';
    } else if (resumeFile.size > REPORT_LIMITS.RESUME_MAX_BYTES) {
      errors.resume = 'The PDF is larger than 3 MB. Please upload a smaller file.';
    }
  } else if (!self && !errors.profile) {
    errors.profile = 'Upload a PDF resume or write a short self description.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}
