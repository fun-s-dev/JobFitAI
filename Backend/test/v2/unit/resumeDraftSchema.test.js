import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ResumeDraftSchema,
  assignDraftIds,
} = require('../../../src/v2/schemas/resumeDraft');


describe('schemas/resumeDraft', () => {
  it('validates a complete, well-formed ResumeDraft', () => {
    const validDraft = {
      summary: 'Experienced full stack developer.',
      experience: [
        {
          id: 'exp0',
          company: 'Acme Corp',
          role: 'Senior Software Engineer',
          dates: '2022 - Present',
          bullets: [
            { id: 'exp0.b0', text: 'Built REST APIs in Express and Node.js.' },
            { id: 'exp0.b1', text: 'Reduced latency by 40% using Redis.' },
          ],
        },
      ],
      projects: [
        {
          id: 'prj0',
          name: 'JobFitAI',
          bullets: [
            { id: 'prj0.b0', text: 'Engineered resume verification engine.' },
          ],
        },
      ],
      skills: ['Node.js', 'Express', 'React', 'MongoDB'],
      education: [
        {
          id: 'edu0',
          school: 'University of Engineering',
          degree: 'B.S. Computer Science',
          dates: '2018 - 2022',
        },
      ],
    };

    const parsed = ResumeDraftSchema.safeParse(validDraft);
    expect(parsed.success).toBe(true);
  });

  it('assigns deterministic IDs in code even if input lacks IDs or supplies bad ones', () => {
    const rawFromModel = {
      summary: 'Talented developer.',
      experience: [
        {
          id: 'random_junk_id',
          company: 'Tech Co',
          role: 'Backend Dev',
          dates: '2021 - 2023',
          bullets: [
            { id: 'hallucinated_bullet_id', text: 'Architected microservices.' },
            'Plain string bullet that should be normalized',
          ],
        },
      ],
      projects: [
        {
          name: 'OpenSource Tool',
          bullets: [
            { text: 'Authored core testing suite.' },
          ],
        },
      ],
      skills: ['Python', 'Docker'],
      education: [
        {
          school: 'Tech Institute',
          degree: 'B.Tech',
          dates: '2017 - 2021',
        },
      ],
    };

    const formatted = assignDraftIds(rawFromModel);

    expect(formatted.experience[0].id).toBe('exp0');
    expect(formatted.experience[0].bullets[0].id).toBe('exp0.b0');
    expect(formatted.experience[0].bullets[0].text).toBe('Architected microservices.');
    expect(formatted.experience[0].bullets[1].id).toBe('exp0.b1');
    expect(formatted.experience[0].bullets[1].text).toBe('Plain string bullet that should be normalized');

    expect(formatted.projects[0].id).toBe('prj0');
    expect(formatted.projects[0].bullets[0].id).toBe('prj0.b0');
    expect(formatted.projects[0].bullets[0].text).toBe('Authored core testing suite.');

    expect(formatted.education[0].id).toBe('edu0');

    // Result satisfies ResumeDraftSchema
    const parseResult = ResumeDraftSchema.safeParse(formatted);
    expect(parseResult.success).toBe(true);
  });

  it('fails validation when mandatory sections are missing', () => {
    const invalid = {
      summary: 'Short summary',
      // missing experience, projects, skills, education
    };

    const parsed = ResumeDraftSchema.safeParse(invalid);
    expect(parsed.success).toBe(false);
  });
});
