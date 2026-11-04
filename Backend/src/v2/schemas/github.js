const { z } = require('zod');

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

/**
 * Analyze a repository for a report. The only source is a repository selected from the connected
 * GitHub account (`repoId`); ownership is verified server-side from GitHub's response.
 * Pasted repository URLs are no longer accepted. The schema is strict so a leftover `repoUrl` (or any
 * client-supplied ownership claim) is rejected instead of silently ignored.
 */
const analyzeRepoBodySchema = z
  .object({
    reportId: z.string().regex(objectIdRegex, 'reportId must be a 24-character hex string'),
    repoId: z.number().int().positive(),
  })
  .strict();

const reportLinksParamsSchema = z.object({
  reportId: z.string().regex(objectIdRegex, 'reportId must be a 24-character hex string'),
});

const setLinkProjectParamsSchema = z.object({
  analysisId: z.string().regex(objectIdRegex, 'analysisId must be a 24-character hex string'),
});

// projectName: the draft project this repository belongs to, or null to go back to automatic matching
const setLinkProjectBodySchema = z
  .object({
    reportId: z.string().regex(objectIdRegex, 'reportId must be a 24-character hex string'),
    projectName: z.string().trim().min(1).max(200).nullable(),
  })
  .strict();

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
  reportLinksParamsSchema,
  setLinkProjectParamsSchema,
  setLinkProjectBodySchema,
  getAnalysisParamsSchema,
  connectStartBodySchema,
};
