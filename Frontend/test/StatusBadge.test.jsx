import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import StatusBadge from '../src/features/verification/components/StatusBadge';

describe('StatusBadge Component', () => {
  it('renders verified state with text and accessible icon', () => {
    render(<StatusBadge status="verified" />);
    const badge = screen.getByRole('status');
    expect(badge).toBeDefined();
    expect(badge.textContent).toContain('Verified');
    // SVG icon must be present (not color alone)
    expect(badge.querySelector('svg')).not.toBeNull();
  });

  it('renders needs_review state with warning text and icon', () => {
    render(<StatusBadge status="needs_review" />);
    const badge = screen.getByRole('status');
    expect(badge.textContent).toContain('Needs Review');
    expect(badge.querySelector('svg')).not.toBeNull();
  });

  it('renders rejected state with rejection text and icon', () => {
    render(<StatusBadge status="rejected" />);
    const badge = screen.getByRole('status');
    expect(badge.textContent).toContain('Rejected');
    expect(badge.querySelector('svg')).not.toBeNull();
  });

  it('renders userOverride decision taking precedence over automated status', () => {
    render(<StatusBadge status="needs_review" userOverride={{ decision: 'approved' }} />);
    const badge = screen.getByRole('status');
    expect(badge.textContent).toContain('Approved');
    expect(badge.textContent).toContain('Override');
    expect(badge.querySelector('svg')).not.toBeNull();
  });

  it('renders userOverride rejected taking precedence over verified automated status', () => {
    render(<StatusBadge status="verified" userOverride={{ decision: 'rejected' }} />);
    const badge = screen.getByRole('status');
    expect(badge.textContent).toContain('Rejected');
    expect(badge.textContent).toContain('Override');
  });
});
