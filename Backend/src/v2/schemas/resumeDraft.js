const { z } = require('zod');

// Canonical Bullet Schema with deterministic ID
const BulletSchema = z.object({
  id: z.string().regex(/^(?:exp|prj)\d+\.b\d+$/, 'Bullet id must follow expX.bY or prjX.bY format'),
  text: z.string().min(1, 'Bullet text cannot be empty'),
});

// Canonical Experience Entry Schema
const ExperienceEntrySchema = z.object({
  id: z.string().regex(/^exp\d+$/, 'Experience id must follow expX format'),
  company: z.string().min(1),
  role: z.string().min(1),
  dates: z.string().default(''),
  bullets: z.array(BulletSchema),
});

// Canonical Project Entry Schema
const ProjectEntrySchema = z.object({
  id: z.string().regex(/^prj\d+$/, 'Project id must follow prjX format'),
  name: z.string().min(1),
  bullets: z.array(BulletSchema),
});

// Canonical Education Entry Schema
const EducationEntrySchema = z.object({
  id: z.string().regex(/^edu\d+$/, 'Education id must follow eduX format'),
  school: z.string().min(1),
  degree: z.string().min(1),
  dates: z.string().default(''),
});

// Full Validated ResumeDraft Schema
const ResumeDraftSchema = z.object({
  summary: z.string(),
  experience: z.array(ExperienceEntrySchema),
  projects: z.array(ProjectEntrySchema),
  skills: z.array(z.string()),
  education: z.array(EducationEntrySchema),
});


// Raw schema requested from Gemini during structured draft generation
// The model is NOT trusted to assign IDs; bullets can be objects with text or raw strings
const RawBulletSchema = z.union([
  z.object({ text: z.string() }),
  z.string(),
]);

const RawDraftSchema = z.object({
  summary: z.string().describe('ATS-friendly professional summary tailored to the job description'),
  experience: z.array(
    z.object({
      company: z.string(),
      role: z.string(),
      dates: z.string().default(''),
      bullets: z.array(RawBulletSchema),
    })
  ).default([]),
  projects: z.array(
    z.object({
      name: z.string(),
      bullets: z.array(RawBulletSchema),
    })
  ).default([]),
  skills: z.array(z.string()).default([]),
  education: z.array(
    z.object({
      school: z.string(),
      degree: z.string(),
      dates: z.string().default(''),
    })
  ).default([]),
});

/**
 * Normalizes a raw draft object and assigns deterministic IDs in code.
 * exp0 -> exp0.b0, exp0.b1...
 * prj0 -> prj0.b0, prj0.b1...
 * edu0, edu1...
 *
 * @param {object} rawDraft
 * @returns {z.infer<typeof ResumeDraftSchema>}
 */
function assignDraftIds(rawDraft = {}) {
  const summary = typeof rawDraft.summary === 'string' ? rawDraft.summary.trim() : '';

  const experience = (Array.isArray(rawDraft.experience) ? rawDraft.experience : []).map(
    (exp, expIdx) => {
      const expId = `exp${expIdx}`;
      const rawBullets = Array.isArray(exp.bullets) ? exp.bullets : [];
      const bullets = rawBullets.map((b, bIdx) => {
        const text = typeof b === 'string' ? b : (b && typeof b.text === 'string' ? b.text : '');
        return {
          id: `${expId}.b${bIdx}`,
          text: text.trim(),
        };
      }).filter((b) => b.text.length > 0);

      return {
        id: expId,
        company: (exp.company || '').trim(),
        role: (exp.role || '').trim(),
        dates: (exp.dates || '').trim(),
        bullets,
      };
    }
  );

  const projects = (Array.isArray(rawDraft.projects) ? rawDraft.projects : []).map(
    (prj, prjIdx) => {
      const prjId = `prj${prjIdx}`;
      const rawBullets = Array.isArray(prj.bullets) ? prj.bullets : [];
      const bullets = rawBullets.map((b, bIdx) => {
        const text = typeof b === 'string' ? b : (b && typeof b.text === 'string' ? b.text : '');
        return {
          id: `${prjId}.b${bIdx}`,
          text: text.trim(),
        };
      }).filter((b) => b.text.length > 0);

      return {
        id: prjId,
        name: (prj.name || '').trim(),
        bullets,
      };
    }
  );

  const skills = (Array.isArray(rawDraft.skills) ? rawDraft.skills : [])
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean);

  const education = (Array.isArray(rawDraft.education) ? rawDraft.education : []).map(
    (edu, eduIdx) => ({
      id: `edu${eduIdx}`,
      school: (edu.school || '').trim(),
      degree: (edu.degree || '').trim(),
      dates: (edu.dates || '').trim(),
    })
  );

  return {
    summary,
    experience,
    projects,
    skills,
    education,
  };
}

module.exports = {
  ResumeDraftSchema,
  RawDraftSchema,
  BulletSchema,
  ExperienceEntrySchema,
  ProjectEntrySchema,
  EducationEntrySchema,
  assignDraftIds,
};
