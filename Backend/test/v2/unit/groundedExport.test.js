import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { filterGroundedDraft, getEffectiveStatus } = require('../../../src/v2/core/groundedExport');

describe('core/groundedExport (pure logic)', () => {
  const sampleDraft = {
    summary: 'Senior Backend Engineer with 6 years experience in distributed systems.',
    experience: [
      {
        id: 'exp0',
        company: 'Stripe',
        role: 'Senior Backend Engineer',
        dates: '2021 - Present',
        bullets: [
          { id: 'exp0.b0', text: 'Architected payment processing pipeline handling 10M events daily.' },
          { id: 'exp0.b1', text: 'Reduced p99 checkout latency by 45% using Redis caching.' },
          { id: 'exp0.b2', text: 'Led a cross-functional squad of 5 engineers.' },
        ],
      },
    ],
    projects: [
      {
        id: 'prj0',
        name: 'JobFitAI',
        bullets: [
          { id: 'prj0.b0', text: 'Developed natural language inference verification engine.' },
          { id: 'prj0.b1', text: 'Integrated AST parsing for GitHub repository inspection.' },
        ],
      },
    ],
    skills: ['Node.js', 'Express', 'Redis', 'MongoDB'],
    education: [
      { id: 'edu0', degree: 'B.S. CS', school: 'Tech University', dates: '2015-2019' },
    ],
  };

  it('computes effective status where userOverride beats automated status', () => {
    expect(getEffectiveStatus({ status: 'needs_review', userOverride: null })).toBe('needs_review');
    expect(getEffectiveStatus({ status: 'verified', userOverride: null })).toBe('verified');
    expect(getEffectiveStatus({ status: 'rejected', userOverride: null })).toBe('rejected');
    expect(getEffectiveStatus({ status: 'needs_review', userOverride: { decision: 'approved' } })).toBe('approved');
    expect(getEffectiveStatus({ status: 'verified', userOverride: { decision: 'rejected' } })).toBe('rejected');
    expect(getEffectiveStatus({ status: 'rejected', userOverride: { decision: 'approved' } })).toBe('approved');
  });

  it('includes bullets where all claims are verified or approved', () => {
    const claims = [
      { bulletId: 'exp0.b0', claimText: '10M events', status: 'verified' },
      { bulletId: 'exp0.b1', claimText: 'Reduced latency by 45%', status: 'needs_review', userOverride: { decision: 'approved' } },
      { bulletId: 'exp0.b2', claimText: 'Led 5 engineers', status: 'verified' },
      { bulletId: 'prj0.b0', claimText: 'NLI verification', status: 'verified' },
      { bulletId: 'prj0.b1', claimText: 'AST parsing', status: 'verified' },
    ];

    const result = filterGroundedDraft(sampleDraft, claims);
    expect(result.excludedBulletIds).toHaveLength(0);
    expect(result.allowedBulletIds).toContain('exp0.b0');
    expect(result.allowedBulletIds).toContain('exp0.b1');
    expect(result.allowedBulletIds).toContain('exp0.b2');
    expect(result.allowedBulletIds).toContain('prj0.b0');
    expect(result.allowedBulletIds).toContain('prj0.b1');
    expect(result.excludedBullets).toEqual([]);
  });

  it('excludes a bullet if any of its claims has effective status needs_review or rejected', () => {
    const claims = [
      { bulletId: 'exp0.b0', claimText: '10M events', status: 'verified' },
      // exp0.b1 has two claims: one verified, one rejected -> whole bullet dropped
      { bulletId: 'exp0.b1', claimText: 'Reduced p99 latency', status: 'verified' },
      { bulletId: 'exp0.b1', claimText: 'Redis caching', status: 'rejected', userOverride: null },
      // exp0.b2 has one claim that needs review without override -> dropped
      { bulletId: 'exp0.b2', claimText: 'Led squad of 5', status: 'needs_review' },
      { bulletId: 'prj0.b0', claimText: 'NLI verification', status: 'verified' },
    ];

    const result = filterGroundedDraft(sampleDraft, claims);
    expect(result.excludedBulletIds).toEqual(expect.arrayContaining(['exp0.b1', 'exp0.b2']));
    expect(result.allowedBulletIds).toContain('exp0.b0');
    expect(result.allowedBulletIds).toContain('prj0.b0');

    // Check exclusion reasons
    const exp0b1Exclusion = result.excludedBullets.find((b) => b.bulletId === 'exp0.b1');
    expect(exp0b1Exclusion).toBeDefined();
    expect(exp0b1Exclusion.reasons[0]).toMatch(/rejected/);

    const exp0b2Exclusion = result.excludedBullets.find((b) => b.bulletId === 'exp0.b2');
    expect(exp0b2Exclusion).toBeDefined();
    expect(exp0b2Exclusion.reasons[0]).toMatch(/needs_review/);
  });

  it('allows bullet if user overrides a rejected or needs_review claim to approved', () => {
    const claims = [
      {
        bulletId: 'exp0.b1',
        claimText: 'Reduced p99 latency by 45%',
        status: 'rejected',
        userOverride: { decision: 'approved' },
      },
    ];

    const result = filterGroundedDraft(sampleDraft, claims);
    expect(result.allowedBulletIds).toContain('exp0.b1');
    expect(result.excludedBulletIds).not.toContain('exp0.b1');
  });

  it('drops a bullet if user overrides a verified claim to rejected', () => {
    const claims = [
      {
        bulletId: 'exp0.b0',
        claimText: 'Architected pipeline',
        status: 'verified',
        userOverride: { decision: 'rejected' },
      },
    ];

    const result = filterGroundedDraft(sampleDraft, claims);
    expect(result.excludedBulletIds).toContain('exp0.b0');
    expect(result.allowedBulletIds).not.toContain('exp0.b0');
  });

  it('does not mutate original claim objects or statuses', () => {
    const claim = {
      bulletId: 'exp0.b0',
      claimText: 'Architected pipeline',
      status: 'verified',
      userOverride: { decision: 'rejected' },
    };
    const cloned = JSON.parse(JSON.stringify(claim));

    filterGroundedDraft(sampleDraft, [claim]);
    expect(claim.status).toBe(cloned.status);
    expect(claim.userOverride.decision).toBe(cloned.userOverride.decision);
  });

  it('excludes bullets with ZERO claims with the reason not verified', () => {
    const draftWithUnclaimed = {
      experience: [
        {
          id: 'exp0',
          bullets: [
            { id: 'exp0.b0', text: 'Supported bullet with verified claim' },
            { id: 'exp0.b1', text: 'Unclaimed bullet with zero claims' },
          ],
        },
      ],
    };

    const claims = [
      { bulletId: 'exp0.b0', claimText: 'Supported bullet', status: 'verified' },
    ];

    const result = filterGroundedDraft(draftWithUnclaimed, claims);
    expect(result.allowedBulletIds).toEqual(['exp0.b0']);
    expect(result.excludedBulletIds).toEqual(['exp0.b1']);

    const unclaimedExclusion = result.excludedBullets.find((b) => b.bulletId === 'exp0.b1');
    expect(unclaimedExclusion).toBeDefined();
    expect(unclaimedExclusion.reasons).toContain('not verified');
  });
});

