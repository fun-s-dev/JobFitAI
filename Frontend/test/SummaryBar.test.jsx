import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
