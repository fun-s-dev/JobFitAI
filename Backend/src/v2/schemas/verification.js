const { z } = require('zod');

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

const reportParamsSchema = z.object({
  reportId: z.string().regex(objectIdRegex, 'Invalid reportId format'),
});

const verifyQuerySchema = z.object({
  runId: z.string().regex(objectIdRegex, 'Invalid runId format').optional(),
});

const verifyBodySchema = z.object({
  draftId: z.string().regex(objectIdRegex, 'Invalid draftId format').optional(),
  githubAnalysisIds: z.array(z.string().regex(objectIdRegex, 'Invalid githubAnalysisId format')).optional(),
});

const claimParamsSchema = z.object({
  claimId: z.string().regex(objectIdRegex, 'Invalid claimId format'),
});

const claimOverrideBodySchema = z.object({
  decision: z.enum(['approved', 'rejected'], {
    errorMap: () => ({ message: "decision must be either 'approved' or 'rejected'" }),
  }),
});

module.exports = {
  reportParamsSchema,
  verifyQuerySchema,
  verifyBodySchema,
  claimParamsSchema,
  claimOverrideBodySchema,
};
