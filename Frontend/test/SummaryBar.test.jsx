import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SummaryBar from '../src/features/verification/components/SummaryBar';

describe('SummaryBar Component', () => {
  const sampleClaims = [
    { id: 'c1', status: 'verified', claimText: 'Claim 1' },
    { id: 'c2', status: 'needs_review', claimText: 'Claim 2' },
  ];

  it('renders download PDF button enabled by default', () => {
    render(
      <SummaryBar
        claims={sampleClaims}
        onPrint={vi.fn()}
        onDownloadPdf={vi.fn()}
        isPdfDisabled={false}
      />
    );

    const downloadBtn = screen.getByRole('button', { name: /download pdf/i });
    expect(downloadBtn.disabled).toBe(false);
  });

  it('disables Download PDF and displays short explanation when server answers 501 (isPdfDisabled=true)', () => {
    render(
      <SummaryBar
        claims={sampleClaims}
        onPrint={vi.fn()}
        onDownloadPdf={vi.fn()}
        isPdfDisabled={true}
      />
    );

    const downloadBtn = screen.getByRole('button', { name: /download pdf/i });
    expect(downloadBtn.disabled).toBe(true);

    const errorNotice = screen.getByRole('alert');
    expect(errorNotice).toBeDefined();
    expect(errorNotice.textContent).toContain('server PDF is disabled; use Print / Save as PDF');
  });

  it('counts excluded non-bullet items, lists their reasons, and shows review warnings', () => {
    const grounded = {
      allowedBulletIds: ['exp0.b0'],
      excludedBullets: [],
      excludedItems: [
        { section: 'skills', text: 'Kubernetes', reason: 'Skill not found in your resume or self-description.' },
        { section: 'summary', text: 'AI summary', reason: 'Not checked claim by claim.' },
      ],
      warnings: [{ section: 'experience', entryId: 'exp0', text: 'Principal Architect', reason: 'Job title wording not found in your resume.' }],
    };

    render(<SummaryBar claims={sampleClaims} grounded={grounded} onPrint={vi.fn()} onDownloadPdf={vi.fn()} />);

    const toggle = screen.getByRole('button', { name: /2 items excluded from export/i });
    expect(screen.queryByText(/Nothing was dropped/)).toBeNull();
    expect(screen.getByTestId('export-warnings').textContent).toContain('Principal Architect');

    fireEvent.click(toggle);
    expect(screen.getByText('"Kubernetes"')).toBeDefined();
    expect(screen.getByText('Skill not found in your resume or self-description.')).toBeDefined();
  });

  it('shows the all-clean message only when nothing at all was excluded', () => {
    const grounded = { allowedBulletIds: ['exp0.b0'], excludedBullets: [], excludedItems: [], warnings: [] };
    render(<SummaryBar claims={sampleClaims} grounded={grounded} onPrint={vi.fn()} onDownloadPdf={vi.fn()} />);
    expect(screen.getByText(/Nothing was dropped/)).toBeDefined();
  });
});
