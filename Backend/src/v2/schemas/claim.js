const { z } = require('zod');

const ClaimTypeEnum = z.enum([
  'technology',
  'responsibility',
  'metric',
  'leadership',
  'outcome',
  'other',
]);

const ClaimSchema = z.object({
  bulletId: z.string().min(1, 'bulletId is required'),
  claimText: z.string().min(1, 'claimText must not be empty'),
  claimType: ClaimTypeEnum,
  skills: z.array(z.string()).default([]),
  numbers: z.array(z.string()).default([]),
});

const BatchClaimsSchema = z.object({
  claims: z.array(ClaimSchema).default([]),
});

module.exports = {
  ClaimTypeEnum,
  ClaimSchema,
  BatchClaimsSchema,
};
