import { describe, it, expect } from 'vitest';
import { validateReportInput, REPORT_LIMITS } from '../src/features/interview/utils/validateReportInput';

const JOB = 'Senior Node.js backend engineer building REST APIs.';
const pdf = (overrides = {}) => ({ name: 'resume.pdf', type: 'application/pdf', size: 1000, ...overrides });

describe('validateReportInput', () => {
  it('accepts a job description with a self description', () => {
    expect(validateReportInput({ jobDescription: JOB, selfDescription: 'Backend developer.' })).toEqual({ valid: true, errors: {} });
  });

  it('accepts a job description with a PDF and no self description', () => {
    expect(validateReportInput({ jobDescription: JOB, resumeFile: pdf() }).valid).toBe(true);
  });

  it('requires a job description of at least 20 characters (after trimming)', () => {
    const r = validateReportInput({ jobDescription: '   short   ', selfDescription: 'x' });
    expect(r.valid).toBe(false);
    expect(r.errors.jobDescription).toMatch(/at least 20/);
  });

  it('rejects an over-long job description', () => {
    const r = validateReportInput({ jobDescription: 'x'.repeat(REPORT_LIMITS.JOB_DESCRIPTION_MAX + 1), selfDescription: 'x' });
    expect(r.errors.jobDescription).toMatch(/at most 5000/);
  });

  it('requires a resume or a self description', () => {
    const r = validateReportInput({ jobDescription: JOB, selfDescription: '   ' });
    expect(r.valid).toBe(false);
    expect(r.errors.profile).toMatch(/Upload a PDF resume or write a short self description/);
  });

  it('rejects non-PDF and oversized files', () => {
    const docx = validateReportInput({ jobDescription: JOB, resumeFile: pdf({ name: 'cv.docx', type: 'application/vnd.ms-word' }) });
    expect(docx.errors.resume).toMatch(/only pdf/i);

    const big = validateReportInput({ jobDescription: JOB, resumeFile: pdf({ size: REPORT_LIMITS.RESUME_MAX_BYTES + 1 }) });
    expect(big.errors.resume).toMatch(/larger than 3 MB/);
  });

  it('accepts a PDF whose MIME type is empty but whose name ends in .pdf', () => {
    expect(validateReportInput({ jobDescription: JOB, resumeFile: pdf({ type: '' }) }).valid).toBe(true);
  });
});
