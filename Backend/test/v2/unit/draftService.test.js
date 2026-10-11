import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDraftService } = require('../../../src/v2/services/draft.service');

describe('services/draft.service', () => {
  it('generates a tailored draft, enforces labeled data blocks, omits temperature, and assigns IDs in code', async () => {
    let capturedCall = null;

    const fakeLlmClient = {
      async generateStructured(params) {
        capturedCall = params;
        return {
          summary: 'Tailored summary for Full Stack Engineer',
          experience: [
            {
              id: 'model_hallucinated_id_99',
              company: 'Fintech Solutions',
              role: 'Backend Lead',
              dates: '2020 - 2024',
              bullets: [
                { id: 'wrong_bullet_id', text: 'Built payment microservices with Express and Redis.' },
                'Cut transaction latency by 30%.',
              ],
            },
          ],
          projects: [
            {
              id: 'bogus_prj_id',
              name: 'CryptoGateway',
              bullets: [
                { id: 'random_id', text: 'Engineered high-throughput ledger.' },
              ],
            },
          ],
          skills: ['Node.js', 'Redis', 'PostgreSQL'],
          education: [
            {
              id: 'edu_bogus',
              school: 'Tech University',
              degree: 'B.S. Software Engineering',
              dates: '2016 - 2020',
            },
          ],
        };
      },
    };

    const draftService = createDraftService({ llmClient: fakeLlmClient });
    const result = await draftService.generateDraft({
      resume: 'Senior Engineer with 5 years experience.',
      selfDescription: 'Passionate about distributed systems.',
      jobDescription: 'Seeking backend engineer skilled in Node.js and Redis.',
    });

    // 1. Verify call parameters
    expect(capturedCall).toBeDefined();
    expect(capturedCall.purpose).toBe('tailor_resume_draft');
    // Temperature must be omitted to preserve Gemini 3 default
    expect(capturedCall.temperature).toBeUndefined();

    // 2. Labeled tags in prompt
    expect(capturedCall.prompt).toContain('<resume>');
    expect(capturedCall.prompt).toContain('Senior Engineer with 5 years experience.');
    expect(capturedCall.prompt).toContain('</resume>');
    expect(capturedCall.prompt).toContain('<self_description>');
    expect(capturedCall.prompt).toContain('<job_description>');

    // 3. IDs assigned in code
    expect(result.experience[0].id).toBe('exp0');
    expect(result.experience[0].bullets[0].id).toBe('exp0.b0');
    expect(result.experience[0].bullets[0].text).toBe('Built payment microservices with Express and Redis.');
    expect(result.experience[0].bullets[1].id).toBe('exp0.b1');
    expect(result.experience[0].bullets[1].text).toBe('Cut transaction latency by 30%.');

    expect(result.projects[0].id).toBe('prj0');
    expect(result.projects[0].bullets[0].id).toBe('prj0.b0');
    expect(result.education[0].id).toBe('edu0');
  });

  it('throws when llmClient fails', async () => {
    const fakeLlmClient = {
      async generateStructured() {
        throw new Error('LLM service unavailable');
      },
    };

    const draftService = createDraftService({ llmClient: fakeLlmClient });
    await expect(
      draftService.generateDraft({ resume: 'foo', jobDescription: 'bar' })
    ).rejects.toThrow('LLM service unavailable');
  });
});
