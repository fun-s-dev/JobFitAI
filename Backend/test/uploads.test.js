import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestKit, teardownTestKit } from './helpers/testKit.js';

describe('Resume Upload Security & Validation Tests', () => {
  let kit;
  let aiService;

  beforeAll(async () => {
    kit = await setupTestKit();
    aiService = kit.require('../../src/services/ai.service');

    vi.spyOn(aiService, 'generateInterviewReport').mockResolvedValue({
      matchScore: 90,
      technicalQuestions: [
        { question: 'Q1', intention: 'I1', answer: 'A1' }
      ],
      behavioralQuestions: [
        { question: 'BQ1', intention: 'BI1', answer: 'BA1' }
      ],
      skillGaps: [{ skill: 'Docker', severity: 'low' }],
      preparationPlan: [{ day: 1, focus: 'Docker', tasks: ['Install Docker'] }],
      title: 'Backend Engineer'
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await teardownTestKit();
  });

  it('rejects non-PDF MIME type (e.g. .docx) with 415 JSON', async () => {
    const fakeDocxBuffer = Buffer.from('PK\x03\x04 fake docx binary data');

    const res = await kit.agentA
      .post('/api/interview')
      .field('jobDescription', 'Senior Node.js Developer')
      .attach('resume', fakeDocxBuffer, {
        filename: 'resume.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });

    expect(res.status).toBe(415);
    expect(res.body.message).toMatch(/only pdf files are allowed/i);
  });

  it('rejects spoofed PDF lacking %PDF- magic bytes with 415 JSON', async () => {
    // Client sends application/pdf Content-Type, but content is malicious script
    const fakeScriptBuffer = Buffer.from('#!/bin/bash\necho "exploit"');

    const res = await kit.agentA
      .post('/api/interview')
      .field('jobDescription', 'Senior Node.js Developer')
      .attach('resume', fakeScriptBuffer, {
        filename: 'resume.pdf',
        contentType: 'application/pdf',
      });

    expect(res.status).toBe(415);
    expect(res.body.message).toMatch(/valid pdf/i);
  });

  it('rejects files larger than 3 MB with 413 JSON', async () => {
    // Generate a 3.5 MB buffer with valid PDF header
    const oversizedBuffer = Buffer.alloc(3.5 * 1024 * 1024);
    oversizedBuffer.write('%PDF-1.4 oversized content');

    const res = await kit.agentA
      .post('/api/interview')
      .field('jobDescription', 'Senior Node.js Developer')
      .attach('resume', oversizedBuffer, {
        filename: 'large_resume.pdf',
        contentType: 'application/pdf',
      });

    expect(res.status).toBe(413);
    expect(res.body.message).toMatch(/file too large/i);
  });

  it('rejects request with missing resume AND missing selfDescription with 400 JSON', async () => {
    const res = await kit.agentA
      .post('/api/interview')
      .field('jobDescription', 'Senior Node.js Developer');

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/either a resume or a self description is required/i);
  });
});
