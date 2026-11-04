const { z } = require('zod');

/**
 * Zod schemas for the V1 API: interview-report requests, the Gemini output, and auth requests.
 * Shared infrastructure (lives under v2/ because V1 files are otherwise frozen).
 */

const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;

const LIMITS = Object.freeze({
  JOB_DESCRIPTION_MIN: 20,
  JOB_DESCRIPTION_MAX: 5000, // matches the Home page textarea maxLength
  SELF_DESCRIPTION_MAX: 5000,
  RESUME_TEXT_MIN: 20, // below this a PDF is treated as "no selectable text"
  RESUME_TEXT_MAX: 30000,
  USERNAME_MIN: 3,
  USERNAME_MAX: 30,
  PASSWORD_MIN: 8,
  PASSWORD_MAX_BYTES: 72, // bcrypt ignores bytes beyond 72
  EMAIL_MAX: 254,
});

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const reportIdParamsSchema = z.object({
  interviewId: z.string().regex(OBJECT_ID_REGEX, 'Invalid report id'),
});

const pdfReportIdParamsSchema = z.object({
  interviewReportId: z.string().regex(OBJECT_ID_REGEX, 'Invalid report id'),
});

// multipart text fields arrive as strings; absent optional fields arrive as undefined
const optionalText = (max, label) =>
  z
    .string({ error: `${label} must be text` })
    .max(max, `${label} must be at most ${max} characters`)
    .transform((s) => s.trim())
    .optional()
    .transform((s) => (s ? s : undefined));

const createReportBodySchema = z.object({
  jobDescription: z
    .string({ error: 'A job description is required.' })
    .transform((s) => s.trim())
    .pipe(
      z
        .string()
        .min(
          LIMITS.JOB_DESCRIPTION_MIN,
          `The job description must be at least ${LIMITS.JOB_DESCRIPTION_MIN} characters.`
        )
        .max(
          LIMITS.JOB_DESCRIPTION_MAX,
          `The job description must be at most ${LIMITS.JOB_DESCRIPTION_MAX} characters.`
        )
    ),
  selfDescription: optionalText(LIMITS.SELF_DESCRIPTION_MAX, 'The self description'),
});

const passwordSchema = z
  .string({ error: 'All fields are required' })
  .min(LIMITS.PASSWORD_MIN, `Password must be at least ${LIMITS.PASSWORD_MIN} characters.`)
  .refine(
    (p) => Buffer.byteLength(p, 'utf8') <= LIMITS.PASSWORD_MAX_BYTES,
    `Password must be at most ${LIMITS.PASSWORD_MAX_BYTES} bytes.`
  );

const emailSchema = z
  .string({ error: 'All fields are required' })
  .transform((s) => s.trim().toLowerCase())
  .pipe(
    z
      .string()
      .max(LIMITS.EMAIL_MAX, 'Email is too long.')
      .pipe(z.email('Please enter a valid email address.'))
  );

const registerBodySchema = z.object({
  username: z
    .string({ error: 'All fields are required' })
    .transform((s) => s.trim())
    .pipe(
      z
        .string()
        .min(LIMITS.USERNAME_MIN, `Username must be at least ${LIMITS.USERNAME_MIN} characters.`)
        .max(LIMITS.USERNAME_MAX, `Username must be at most ${LIMITS.USERNAME_MAX} characters.`)
        .regex(/^[A-Za-z0-9_.-]+$/, 'Username may only contain letters, numbers, ".", "_" and "-".')
    ),
  email: emailSchema,
  password: passwordSchema,
  inviteCode: z.string().max(200).optional(),
});

// Login deliberately gives no format hints: every failure is "Invalid email or password".
const deleteAccountBodySchema = z.object({
  password: z
    .string({ error: 'Enter your password to delete your account.' })
    .min(1, 'Enter your password to delete your account.')
    .max(1024, 'Incorrect password.'),
});

const loginBodySchema = z.object({
  email: z
    .string({ error: 'Invalid email or password' })
    .max(LIMITS.EMAIL_MAX, 'Invalid email or password')
    .transform((s) => s.trim()),
  password: z
    .string({ error: 'Invalid email or password' })
    .min(1, 'Invalid email or password')
    .max(1024, 'Invalid email or password'),
});

// ---------------------------------------------------------------------------
// Gemini output (validated by llmClient.generateStructured, with one repair retry)
// ---------------------------------------------------------------------------

// Gemini rejects this report schema (400 INVALID_ARGUMENT) when arrays carry minItems/maxItems
// (verified against the real API). Array sizes are therefore enforced with refinements, which
// Zod still checks on the response but does not emit into the JSON schema sent to Gemini.
const boundedArray = (item, min, max) =>
  z.array(item).refine((a) => a.length >= min && a.length <= max, {
    message: `Expected between ${min} and ${max} items`,
  });

const questionSchema = z.object({
  question: z.string().min(1).max(1000).describe('The question that may be asked in the interview'),
  intention: z.string().min(1).max(1500).describe("The interviewer's intention behind the question"),
  answer: z
    .string()
    .min(1)
    .max(4000)
    .describe('How to answer: key points to cover and the approach to take'),
});

const interviewReportAiSchema = z.object({
  matchScore: z
    .number()
    .min(0)
    .max(100)
    .describe(
      "A score from 0 to 100 for how well the candidate's profile matches the job description"
    ),
  technicalQuestions: boundedArray(questionSchema, 1, 30)
    .describe('Technical questions with the interviewer intention and how to answer'),
  behavioralQuestions: boundedArray(questionSchema, 1, 30)
    .describe('Behavioral questions with the interviewer intention and how to answer'),
  skillGaps: boundedArray(
    z.object({
      skill: z.string().min(1).max(200).describe('A skill the candidate is lacking for this job'),
      severity: z.enum(['low', 'medium', 'high']).describe('How much the gap matters for this job'),
    }),
    0,
    30
  )
    .describe('Skill gaps with severity'),
  preparationPlan: boundedArray(
    z.object({
      day: z.number().min(1).max(60).describe('Day number, starting from 1'),
      focus: z.string().min(1).max(300).describe('Main focus of this day'),
      tasks: boundedArray(z.string().min(1).max(500), 1, 15).describe('Tasks for this day'),
    }),
    1,
    30
  )
    .describe('A day-wise preparation plan'),
  title: z.string().min(1).max(200).describe('The job title the report is for'),
});

module.exports = {
  LIMITS,
  OBJECT_ID_REGEX,
  reportIdParamsSchema,
  pdfReportIdParamsSchema,
  createReportBodySchema,
  registerBodySchema,
  loginBodySchema,
  deleteAccountBodySchema,
  interviewReportAiSchema,
};
