const { z } = require('zod');

const jobParamsSchema = z.object({
  id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid jobId format'),
});

module.exports = {
  jobParamsSchema,
};
