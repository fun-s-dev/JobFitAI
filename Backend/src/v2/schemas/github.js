const { z } = require('zod');

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

/**
 * Analyze a repository for a report. Exactly one source is accepted:
 *  - repoUrl : pasted public URL (existing mode). Ownership is NOT verified.
 *  - repoId  : a repository selected from the connected GitHub account. Ownership is verified
 *              server-side from GitHub's response.
 */
const analyzeRepoBodySchema = z
  .object({
    reportId: z.string().regex(objectIdRegex, 'reportId must be a 24-character hex string'),
    repoUrl: z.string().url('repoUrl must be a valid URL').optional(),
    repoId: z.number().int().positive().optional(),
  })
  .refine((body) => (body.repoUrl !== undefined) !== (body.repoId !== undefined), {
    message: 'Provide exactly one of repoUrl or repoId',
    path: ['repoId'],
  });

const getAnalysisParamsSchema = z.object({
  analysisId: z.string().regex(objectIdRegex, 'analysisId must be a 24-character hex string'),
});

// Only same-site frontend paths can be requested as the post-authorization landing page
const connectStartBodySchema = z
  .object({
    returnTo: z
      .string()
      .max(100)
      .regex(/^\/(interview\/[0-9a-f]{24}\/verify)?$/, 'Invalid returnTo')
      .optional(),
  })
  .optional();

module.exports = {
  analyzeRepoBodySchema,
  getAnalysisParamsSchema,
  connectStartBodySchema,
};
