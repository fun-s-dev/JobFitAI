const { z } = require('zod');

const analyzeRepoBodySchema = z.object({
  reportId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'reportId must be a 24-character hex string'),
  repoUrl: z.string().url('repoUrl must be a valid URL'),
});

const getAnalysisParamsSchema = z.object({
  analysisId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'analysisId must be a 24-character hex string'),
});

module.exports = {
  analyzeRepoBodySchema,
  getAnalysisParamsSchema,
};
