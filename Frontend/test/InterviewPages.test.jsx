import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

vi.mock('../src/features/interview/services/interview.api', () => ({
  getAllInterviewReports: vi.fn(),
  generateInterviewReport: vi.fn(),
  getInterviewReportById: vi.fn(),
  generateResumePdf: vi.fn(),
  deleteInterviewReport: vi.fn(),
  deleteAccount: vi.fn(),
}));

import {
  getAllInterviewReports,
  generateInterviewReport,
  getInterviewReportById,
  deleteInterviewReport,
  deleteAccount,
} from '../src/features/interview/services/interview.api';
import { AuthContext } from '../src/features/auth/auth.context';
import { InterviewProvider } from '../src/features/interview/interview.context';
import Home from '../src/features/interview/pages/Home';
import Interview from '../src/features/interview/pages/Interview';

const JOB = 'Senior Node.js backend engineer building REST APIs and data pipelines.';

const sampleReport = {
  _id: 'r1',
  title: 'Backend Engineer',
  matchScore: 82,
  technicalQuestions: [{ question: 'What is the event loop?', intention: 'Fundamentals', answer: 'Explain phases.' }],
  behavioralQuestions: [{ question: 'Tell me about a conflict', intention: 'Teamwork', answer: 'STAR' }],
  skillGaps: [{ skill: 'Kubernetes', severity: 'medium' }],
  preparationPlan: [{ day: 1, focus: 'Node.js', tasks: ['Review the event loop'] }],
};

const setUser = vi.fn();

function renderApp(initialPath) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthContext.Provider value={{ user: { id: 'u1' }, setUser, loading: false, setLoading: vi.fn() }}>
        <InterviewProvider>
          <Routes>
            <Route path='/' element={<Home />} />
            <Route path='/interview/:interviewId' element={<Interview />} />
          </Routes>
        </InterviewProvider>
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

describe('Home page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAllInterviewReports.mockResolvedValue({ interviewReports: [] });
  });

  const fillJob = (text = JOB) =>
    fireEvent.change(screen.getByLabelText(/target job description/i), { target: { value: text } });
  const fillSelf = (text = 'Backend developer with 3 years of Node.js.') =>
    fireEvent.change(screen.getByPlaceholderText(/briefly describe your experience/i), { target: { value: text } });
  const clickGenerate = () => fireEvent.click(screen.getByRole('button', { name: /generate my interview strategy/i }));

  it('no longer offers the demo-resume button', async () => {
    renderApp('/');
    await waitFor(() => expect(getAllInterviewReports).toHaveBeenCalled());
    expect(screen.queryByText(/my-resume\.pdf/i)).toBeNull();
  });

  it('shows validation errors and sends nothing when the form is incomplete', async () => {
    renderApp('/');
    await waitFor(() => expect(getAllInterviewReports).toHaveBeenCalled());

    clickGenerate();

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.map((a) => a.textContent).join(' ')).toMatch(/job description/i);
    expect(alerts.map((a) => a.textContent).join(' ')).toMatch(/upload a pdf resume or write a short self description/i);
    expect(generateInterviewReport).not.toHaveBeenCalled();
  });

  it('shows the backend message and keeps what the user typed when generation fails', async () => {
    generateInterviewReport.mockRejectedValueOnce({
      response: { status: 429, data: { message: 'Daily interview report limit reached (10 AI requests per day).', error: { message: 'Daily interview report limit reached (10 AI requests per day).' } } },
    });
    renderApp('/');
    await waitFor(() => expect(getAllInterviewReports).toHaveBeenCalled());

    fillJob();
    fillSelf();
    clickGenerate();

    expect(await screen.findByText(/daily interview report limit reached/i)).toBeDefined();
    // The form is back with the user's text intact (it used to be wiped by the loading screen)
    expect(screen.getByLabelText(/target job description/i).value).toBe(JOB);
    expect(screen.getByPlaceholderText(/briefly describe your experience/i).value).toBe('Backend developer with 3 years of Node.js.');
  });

  it('sends only the fields that have values (no "undefined" resume) and navigates to the new report', async () => {
    generateInterviewReport.mockResolvedValueOnce({ interviewReport: sampleReport });
    getInterviewReportById.mockResolvedValueOnce({ interviewReport: sampleReport });
    renderApp('/');
    await waitFor(() => expect(getAllInterviewReports).toHaveBeenCalled());

    fillJob();
    fillSelf();
    clickGenerate();

    await waitFor(() => expect(generateInterviewReport).toHaveBeenCalledTimes(1));
    expect(generateInterviewReport.mock.calls[0][0]).toMatchObject({ jobDescription: JOB, resumeFile: null });
    expect(await screen.findByText('Technical Questions', { selector: 'h2' })).toBeDefined();
  });

  it('shows a list-loading problem without hiding the form', async () => {
    getAllInterviewReports.mockRejectedValueOnce(new Error('Network Error'));
    renderApp('/');

    expect(await screen.findByText(/cannot reach the server/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /generate my interview strategy/i })).toBeDefined();
  });

  it('rejects a non-PDF upload before any request', async () => {
    renderApp('/');
    await waitFor(() => expect(getAllInterviewReports).toHaveBeenCalled());

    fillJob();
    const input = document.querySelector('input[type="file"]');
    const bad = new File(['x'], 'cv.docx', { type: 'application/msword' });
    fireEvent.change(input, { target: { files: [bad] } });
    clickGenerate();

    expect(await screen.findByText(/only pdf files are supported/i)).toBeDefined();
    expect(generateInterviewReport).not.toHaveBeenCalled();
  });
});

describe('Home page: data deletion', () => {
  const plans = [
    { _id: 'r1', title: 'Backend Engineer', matchScore: 82, createdAt: '2026-10-01T00:00:00Z' },
    { _id: 'r2', title: 'Data Engineer', matchScore: 61, createdAt: '2026-10-02T00:00:00Z' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    getAllInterviewReports.mockResolvedValue({ interviewReports: plans });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('deletes a plan after confirmation and removes it from the list without opening it', async () => {
    deleteInterviewReport.mockResolvedValue({ deleted: true });
    renderApp('/');

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Backend Engineer' }));

    await waitFor(() => expect(deleteInterviewReport).toHaveBeenCalledWith('r1'));
    await waitFor(() => expect(screen.queryByText('Backend Engineer')).toBeNull());
    expect(screen.getByText('Data Engineer')).toBeDefined();
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/permanently/i));
    expect(getInterviewReportById).not.toHaveBeenCalled(); // the click did not navigate into the plan
  });

  it('does nothing when the user cancels the confirmation', async () => {
    window.confirm.mockReturnValue(false);
    renderApp('/');

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Backend Engineer' }));

    expect(deleteInterviewReport).not.toHaveBeenCalled();
    expect(screen.getByText('Backend Engineer')).toBeDefined();
  });

  it('keeps the plan and shows the reason when deletion is refused (for example a job is running)', async () => {
    deleteInterviewReport.mockRejectedValue({
      response: { status: 409, data: { message: 'A verification or GitHub analysis is still running. Please wait for it to finish, then try again.' } },
    });
    renderApp('/');

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Backend Engineer' }));

    expect(await screen.findByText(/still running/i)).toBeDefined();
    expect(screen.getByText('Backend Engineer')).toBeDefined();
  });

  it('deletes the account only with a password and confirmation, then signs the user out', async () => {
    deleteAccount.mockResolvedValue({ message: 'deleted' });
    renderApp('/');

    const password = await screen.findByLabelText(/password to confirm account deletion/i);
    const submit = screen.getByRole('button', { name: 'Delete my account' });
    expect(submit.disabled).toBe(true); // no password yet

    fireEvent.change(password, { target: { value: 'Password123!' } });
    fireEvent.click(submit);

    await waitFor(() => expect(deleteAccount).toHaveBeenCalledWith({ password: 'Password123!' }));
    await waitFor(() => expect(setUser).toHaveBeenCalledWith(null));
  });

  it('shows the server message for a wrong password and keeps the user signed in', async () => {
    deleteAccount.mockRejectedValue({ response: { status: 400, data: { message: 'Incorrect password.' } } });
    renderApp('/');

    fireEvent.change(await screen.findByLabelText(/password to confirm account deletion/i), { target: { value: 'nope-nope-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));

    expect(await screen.findByText('Incorrect password.')).toBeDefined();
    expect(setUser).not.toHaveBeenCalled();
  });

  it('does not delete the account when the confirmation is declined', async () => {
    window.confirm.mockReturnValue(false);
    renderApp('/');

    fireEvent.change(await screen.findByLabelText(/password to confirm account deletion/i), { target: { value: 'Password123!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));

    expect(deleteAccount).not.toHaveBeenCalled();
  });
});

describe('Interview page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the report with its sections', async () => {
    getInterviewReportById.mockResolvedValueOnce({ interviewReport: sampleReport });
    renderApp('/interview/r1');

    expect(await screen.findByText('What is the event loop?')).toBeDefined();
    expect(screen.getByText('Kubernetes')).toBeDefined();
    expect(screen.getByText('82')).toBeDefined();
  });

  it('shows a clear not-found message instead of loading forever', async () => {
    getInterviewReportById.mockRejectedValueOnce({ response: { status: 404, data: { message: 'Interview report not found.' } } });
    renderApp('/interview/missing');

    expect(await screen.findByText(/we couldn't open this interview plan/i)).toBeDefined();
    expect(screen.getByRole('alert').textContent).toMatch(/not found/i);
    expect(screen.queryByText(/loading your interview plan/i)).toBeNull();
    expect(screen.getByRole('button', { name: /back to my plans/i })).toBeDefined();
  });

  it('shows the network problem when the server cannot be reached', async () => {
    getInterviewReportById.mockRejectedValueOnce(new Error('Network Error'));
    renderApp('/interview/r1');
    expect(await screen.findByText(/cannot reach the server/i)).toBeDefined();
  });

  it('does not crash on a stored report that is missing optional arrays', async () => {
    getInterviewReportById.mockResolvedValueOnce({ interviewReport: { _id: 'r2', title: 'Old', matchScore: 40 } });
    renderApp('/interview/r2');
    expect(await screen.findByText(/0 questions/i)).toBeDefined();
    expect(screen.getByText(/weak match for this role/i)).toBeDefined();
  });
});
