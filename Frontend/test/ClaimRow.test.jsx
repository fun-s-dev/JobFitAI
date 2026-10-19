import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ClaimRow from '../src/features/verification/components/ClaimRow';

describe('ClaimRow Component', () => {
  const sampleClaim = {
    id: 'claim-1',
    bulletId: 'exp0.b0',
    claimText: 'Architected high-throughput payment pipeline with Redis.',
    status: 'needs_review',
    confidenceScore: 0.65,
    userOverride: null,
    entailment: {
      verdict: 'partial',
      evidenceQuote: 'Built caching layer with Redis.',
      missingElements: ['high-throughput'],
    },
    resumeEvidence: [
      {
        source: 'resume',
        section: 'Experience',
        text: 'Built caching layer with Redis in production.',
        start: 0,
        end: 30,
        similarityScore: 0.82,
      },
    ],
  };

  it('renders claim text, confidence score, and StatusBadge', () => {
    render(<ClaimRow claim={sampleClaim} onDecide={vi.fn()} />);

    expect(screen.getByText(/Architected high-throughput payment pipeline with Redis/i)).toBeDefined();
    expect(screen.getByText(/65%/)).toBeDefined();
    expect(screen.getByRole('status')).toBeDefined();
    expect(screen.getByRole('status').textContent).toContain('Needs Review');
  });

  it('toggles evidence panel open and closed on header click with aria-expanded', () => {
    render(<ClaimRow claim={sampleClaim} onDecide={vi.fn()} />);

    const toggleButton = screen.getByRole('button', { name: /toggle evidence/i });
    expect(toggleButton.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/Built caching layer with Redis in production/i)).toBeNull();

    // Click to expand
    fireEvent.click(toggleButton);
    expect(toggleButton.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByText(/Built caching layer with Redis/i).length).toBeGreaterThanOrEqual(1);

    // Click to collapse
    fireEvent.click(toggleButton);
    expect(toggleButton.getAttribute('aria-expanded')).toBe('false');
  });

  it('triggers onDecide callback when Approve button is clicked', () => {
    const handleDecide = vi.fn();
    render(<ClaimRow claim={sampleClaim} onDecide={handleDecide} />);

    const approveButton = screen.getByRole('button', { name: /approve claim/i });
    fireEvent.click(approveButton);

    expect(handleDecide).toHaveBeenCalledWith('claim-1', 'approved');
  });

  it('triggers onDecide callback when Reject button is clicked', () => {
    const handleDecide = vi.fn();
    render(<ClaimRow claim={sampleClaim} onDecide={handleDecide} />);

    const rejectButton = screen.getByRole('button', { name: /reject claim/i });
    fireEvent.click(rejectButton);

    expect(handleDecide).toHaveBeenCalledWith('claim-1', 'rejected');
  });

  it('disables decision buttons when isMutating is true', () => {
    render(<ClaimRow claim={sampleClaim} onDecide={vi.fn()} isMutating={true} />);

    const approveButton = screen.getByRole('button', { name: /approve claim/i });
    const rejectButton = screen.getByRole('button', { name: /reject claim/i });

    expect(approveButton.disabled).toBe(true);
    expect(rejectButton.disabled).toBe(true);
  });

  describe('confirmation step for rejected claims', () => {
    it('prompts window.confirm and calls onDecide if user confirms', () => {
      const handleDecide = vi.fn();
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

      const rejectedClaim = {
        ...sampleClaim,
        status: 'rejected',
      };

      render(<ClaimRow claim={rejectedClaim} onDecide={handleDecide} />);

      const approveButton = screen.getByRole('button', { name: /approve claim/i });
      fireEvent.click(approveButton);

      expect(confirmSpy).toHaveBeenCalledWith(
        'This claim was rejected by verification; include it anyway?'
      );
      expect(handleDecide).toHaveBeenCalledWith('claim-1', 'approved');

      confirmSpy.mockRestore();
    });

    it('prompts window.confirm and aborts if user cancels', () => {
      const handleDecide = vi.fn();
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

      const rejectedClaim = {
        ...sampleClaim,
        status: 'rejected',
      };

      render(<ClaimRow claim={rejectedClaim} onDecide={handleDecide} />);

      const approveButton = screen.getByRole('button', { name: /approve claim/i });
      fireEvent.click(approveButton);

      expect(confirmSpy).toHaveBeenCalledWith(
        'This claim was rejected by verification; include it anyway?'
      );
      expect(handleDecide).not.toHaveBeenCalled();

      confirmSpy.mockRestore();
    });

    it('does not prompt window.confirm for non-rejected claims', () => {
      const handleDecide = vi.fn();
      const confirmSpy = vi.spyOn(window, 'confirm');

      render(<ClaimRow claim={sampleClaim} onDecide={handleDecide} />);

      const approveButton = screen.getByRole('button', { name: /approve claim/i });
      fireEvent.click(approveButton);

      expect(confirmSpy).not.toHaveBeenCalled();
      expect(handleDecide).toHaveBeenCalledWith('claim-1', 'approved');

      confirmSpy.mockRestore();
    });
  });
});

