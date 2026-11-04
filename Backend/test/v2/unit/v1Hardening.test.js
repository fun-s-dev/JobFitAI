import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const {
  LIMITS,
  createReportBodySchema,
  registerBodySchema,
  loginBodySchema,
  interviewReportAiSchema,
  reportIdParamsSchema,
} = require('../../../src/v2/schemas/v1');
const { createInterviewReportService } = require('../../../src/v2/services/interviewReport.service');
const { createInFlightLimiter, sendV1Error, globalErrorHandler } = require('../../../src/v2/middlewares/v1Http');
const { checkBudget, BUDGET_TYPES } = require('../../../src/v2/core/budgetGuards');

const goodAiReport = () => ({
  matchScore: 71.6,
  title: ' Backend Engineer ',
  technicalQuestions: [{ question: 'Q', intention: 'I', answer: 'A' }],
  behavioralQuestions: [{ question: 'Q', intention: 'I', answer: 'A' }],
  skillGaps: [{ skill: 'Docker', severity: 'low' }],
  preparationPlan: [{ day: 1, focus: 'Docker', tasks: ['Install Docker'] }],
});

describe('schemas/v1: Gemini output (interviewReportAiSchema)', () => {
  it('accepts a complete report and strips unknown fields', () => {
    const parsed = interviewReportAiSchema.safeParse({ ...goodAiReport(), role: 'admin' });
    expect(parsed.success).toBe(true);
    expect(parsed.data.role).toBeUndefined();
  });

  it.each([
    ['score above 100', { matchScore: 101 }],
    ['negative score', { matchScore: -1 }],
    ['score as a string', { matchScore: '80' }],
    ['no technical questions', { technicalQuestions: [] }],
    ['no behavioral questions', { behavioralQuestions: [] }],
    ['unknown severity', { skillGaps: [{ skill: 'Go', severity: 'critical' }] }],
    ['empty plan', { preparationPlan: [] }],
    ['plan day without tasks', { preparationPlan: [{ day: 1, focus: 'x', tasks: [] }] }],
    ['question missing its answer', { technicalQuestions: [{ question: 'Q', intention: 'I' }] }],
    ['empty title', { title: '' }],
    ['absurdly long answer', { technicalQuestions: [{ question: 'Q', intention: 'I', answer: 'a'.repeat(5000) }] }],
  ])('rejects %s', (_label, override) => {
    expect(interviewReportAiSchema.safeParse({ ...goodAiReport(), ...override }).success).toBe(false);
  });
});

describe('schemas/v1: requests', () => {
  it('createReportBodySchema trims text and turns a blank self description into undefined', () => {
    const parsed = createReportBodySchema.parse({
      jobDescription: '  Senior engineer building distributed systems.  ',
      selfDescription: '   ',
    });
    expect(parsed.jobDescription).toBe('Senior engineer building distributed systems.');
    expect(parsed.selfDescription).toBeUndefined();
  });

  it('createReportBodySchema enforces the job description bounds', () => {
    expect(createReportBodySchema.safeParse({ jobDescription: 'x'.repeat(LIMITS.JOB_DESCRIPTION_MIN - 1) }).success).toBe(false);
    expect(createReportBodySchema.safeParse({ jobDescription: 'x'.repeat(LIMITS.JOB_DESCRIPTION_MAX) }).success).toBe(true);
    expect(createReportBodySchema.safeParse({ jobDescription: 'x'.repeat(LIMITS.JOB_DESCRIPTION_MAX + 1) }).success).toBe(false);
  });

  it('createReportBodySchema ignores unrelated multipart fields such as a literal "resume" string', () => {
    const parsed = createReportBodySchema.parse({
      jobDescription: 'Senior engineer building distributed systems.',
      resume: 'undefined',
    });
    expect(parsed.resume).toBeUndefined();
  });

  it('registerBodySchema normalizes email and counts password bytes, not characters', () => {
    const ok = registerBodySchema.parse({ username: 'user_1', email: ' A@B.Co ', password: 'longenough' });
    expect(ok.email).toBe('a@b.co');

    // 25 three-byte characters = 75 bytes > 72
    const tooManyBytes = registerBodySchema.safeParse({ username: 'user_1', email: 'a@b.co', password: '€'.repeat(25) });
    expect(tooManyBytes.success).toBe(false);
  });

  it('loginBodySchema only accepts strings', () => {
    expect(loginBodySchema.safeParse({ email: 'a@b.co', password: 'x' }).success).toBe(true);
    expect(loginBodySchema.safeParse({ email: { $ne: null }, password: 'x' }).success).toBe(false);
    expect(loginBodySchema.safeParse({ email: 'a@b.co', password: ['x'] }).success).toBe(false);
  });

  it('reportIdParamsSchema accepts only 24-hex ids', () => {
    expect(reportIdParamsSchema.safeParse({ interviewId: '507f1f77bcf86cd799439011' }).success).toBe(true);
    expect(reportIdParamsSchema.safeParse({ interviewId: '../../etc/passwd' }).success).toBe(false);
  });
});

describe('services/interviewReport.service', () => {
  it('sends data-tagged prompts through llmClient.generateStructured with the audited purpose and user', async () => {
    const llmClient = { generateStructured: vi.fn(async () => goodAiReport()) };
    const service = createInterviewReportService({ llmClient });

    const result = await service.generateInterviewReport({
      resume: 'Resume text',
      selfDescription: '',
      jobDescription: 'Job text',
      user: 'user-1',
      requestId: 'req-1',
    });

    const call = llmClient.generateStructured.mock.calls[0][0];
    expect(call.purpose).toBe('interview_report');
    expect(call.user).toBe('user-1');
    expect(call.requestId).toBe('req-1');
    expect(call.schema).toBe(interviewReportAiSchema);
    expect(call.temperature).toBeUndefined(); // Gemini 3: default temperature
    expect(call.prompt).toContain('<resume>\nResume text\n</resume>');
    expect(call.prompt).toContain('<self_description>\n(not provided)\n</self_description>');
    expect(call.prompt).toContain('<job_description>\nJob text\n</job_description>');
    expect(call.system).toMatch(/Never invent experience/);

    expect(result.matchScore).toBe(72);
    expect(result.title).toBe('Backend Engineer');
  });

  it('propagates llmClient failures unchanged for the controller to map', async () => {
    const boom = Object.assign(new Error('upstream'), { name: 'LlmValidationError' });
    const service = createInterviewReportService({ llmClient: { generateStructured: vi.fn(async () => { throw boom; }) } });
    await expect(service.generateInterviewReport({ jobDescription: 'x'.repeat(30) })).rejects.toBe(boom);
  });
});

describe('middlewares/v1Http', () => {
  function fakeRes() {
    const res = new EventEmitter();
    res.statusCode = null;
    res.status = vi.fn((c) => { res.statusCode = c; return res; });
    res.json = vi.fn((b) => { res.body = b; return res; });
    res.headersSent = false;
    return res;
  }

  it('sendV1Error returns the combined legacy + structured shape', () => {
    const res = fakeRes();
    sendV1Error({ id: 'req-9', headers: {} }, res, 418, 'TEAPOT', 'Short and stout', [{ a: 1 }]);
    expect(res.statusCode).toBe(418);
    expect(res.body).toEqual({
      message: 'Short and stout',
      error: { code: 'TEAPOT', message: 'Short and stout', requestId: 'req-9', details: [{ a: 1 }] },
    });
  });

  it('in-flight limiter blocks a second request per user and frees the slot on close', () => {
    const limit = createInFlightLimiter();
    const next1 = vi.fn();
    const next2 = vi.fn();
    const next3 = vi.fn();
    const res1 = fakeRes();
    const res2 = fakeRes();
    const res3 = fakeRes();

    limit({ user: { id: 'u1' }, headers: {} }, res1, next1);
    limit({ user: { id: 'u1' }, headers: {} }, res2, next2);
    limit({ user: { id: 'u2' }, headers: {} }, res3, next3);

    expect(next1).toHaveBeenCalled();
    expect(next2).not.toHaveBeenCalled();
    expect(res2.statusCode).toBe(409);
    expect(res2.body.error.code).toBe('REQUEST_IN_PROGRESS');
    expect(next3).toHaveBeenCalled(); // another user is independent

    res1.emit('close');
    res1.emit('finish'); // releasing twice is harmless
    const next4 = vi.fn();
    limit({ user: { id: 'u1' }, headers: {} }, fakeRes(), next4);
    expect(next4).toHaveBeenCalled();
  });

  it('globalErrorHandler never exposes the raw message of an unexpected error', () => {
    const res = fakeRes();
    const log = { error: vi.fn() };
    globalErrorHandler(new Error('db password is hunter2'), { headers: {}, log }, res, vi.fn());
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(log.error).toHaveBeenCalled();
  });
});

describe('core/budgetGuards: per-user report cap', () => {
  it('allows below the cap and blocks at it with a specific message', () => {
    expect(checkBudget({ type: BUDGET_TYPES.USER_REPORTS, currentCount: 9, maxLimit: 10 }).allowed).toBe(true);
    const blocked = checkBudget({ type: BUDGET_TYPES.USER_REPORTS, currentCount: 10, maxLimit: 10 });
    expect(blocked.allowed).toBe(false);
    expect(blocked.error.code).toBe('DAILY_BUDGET_REACHED');
    expect(blocked.error.message).toMatch(/daily interview report limit reached \(10/i);
  });
});
