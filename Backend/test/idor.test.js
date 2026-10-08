import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestKit, teardownTestKit } from './helpers/testKit.js';

describe('IDOR Security Tests — Interview Reports & PDF Export', () => {
  let kit;
  let aiService;
  let interviewReportModel;
  let userAReport;

  beforeAll(async () => {
    kit = await setupTestKit();
    aiService = kit.require('../../src/services/ai.service');
    interviewReportModel = kit.require('../../src/models/interviewReport.model');

    // Fake Gemini & Puppeteer PDF generation
    vi.spyOn(aiService, 'generateResumePdf').mockResolvedValue(Buffer.from('%PDF-1.4 mock pdf binary'));

    // Create a report owned by User A (Alice)
    userAReport = await interviewReportModel.create({
      user: kit.userA.id,
      title: 'Full Stack Engineer at Google',
      resume: 'Alice Resume with React and Node',
      selfDescription: 'Experienced developer',
      jobDescription: 'Looking for a Senior Full Stack Engineer',
      matchScore: 85,
      technicalQuestions: [
        { question: 'What is event loop?', intention: 'Check Node concurrency', answer: 'Call stack and task queue' }
      ],
      behavioralQuestions: [
        { question: 'Tell me about a conflict', intention: 'Check teamwork', answer: 'STAR method' }
      ],
      skillGaps: [{ skill: 'Redis', severity: 'medium' }],
      preparationPlan: [{ day: 1, focus: 'Node.js', tasks: ['Review event loop'] }]
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await teardownTestKit();
  });

  it('IDOR Vulnerability Check: User B MUST receive 404 when requesting User A report PDF', async () => {
    // User B attempts to access User A's report PDF
    const res = await kit.agentB.post(`/api/interview/resume/pdf/${userAReport._id}`);

    // Ownership check must prevent access: expect 404 (not 200)
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/not found/i);
  });

  it('User A can successfully export their own report PDF', async () => {
    const res = await kit.agentA.post(`/api/interview/resume/pdf/${userAReport._id}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
  });

  it('User B receives 404 when attempting to fetch User A report by ID', async () => {
    const res = await kit.agentB.get(`/api/interview/report/${userAReport._id}`);
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/not found/i);
  });

  it('getAllInterviewReports scopes by authenticated user', async () => {
    // User A should see their 1 report
    const resA = await kit.agentA.get('/api/interview');
    expect(resA.status).toBe(200);
    expect(resA.body.interviewReports.length).toBe(1);
    expect(resA.body.interviewReports[0]._id.toString()).toBe(userAReport._id.toString());

    // User B should see 0 reports
    const resB = await kit.agentB.get('/api/interview');
    expect(resB.status).toBe(200);
    expect(resB.body.interviewReports.length).toBe(0);
  });
});
