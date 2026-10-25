import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getReportOutputPath } = require('../../../../evaluation/scripts/eval-runner');

describe('Evaluation Report Output Path Routing (Never Overwrite Canonical Reports)', () => {
  const reportsDir = path.resolve('evaluation/reports');

  it('routes limited runs (--limit 5) to reports/smoke/ so canonical report is protected', () => {
    const result = getReportOutputPath({
      reportsDir,
      slug: 'ablation-d',
      limit: 5,
    });

    expect(result.isLimitedOrSmoke).toBe(true);
    expect(result.targetDir).toBe(path.join(reportsDir, 'smoke'));
    expect(result.finalReportPath).toBe(path.join(reportsDir, 'smoke', 'ablation-d-report.json'));
    expect(result.partialReportPath).toBe(path.join(reportsDir, 'smoke', 'partial-ablation-d.json'));
    // Crucial check: does not equal the canonical report path
    expect(result.finalReportPath).not.toBe(path.join(reportsDir, 'ablation-d-report.json'));
  });

  it('routes CI / smoke slugs (ablation-d-ci) to reports/smoke/ even without limit flag', () => {
    const result = getReportOutputPath({
      reportsDir,
      slug: 'ablation-d-ci',
      limit: null,
    });

    expect(result.isLimitedOrSmoke).toBe(true);
    expect(result.targetDir).toBe(path.join(reportsDir, 'smoke'));
    expect(result.finalReportPath).toBe(path.join(reportsDir, 'smoke', 'ablation-d-ci-report.json'));
  });

  it('routes canonical, unlimited benchmark runs directly to reportsDir', () => {
    const result = getReportOutputPath({
      reportsDir,
      slug: 'ablation-d',
      limit: null,
    });

    expect(result.isLimitedOrSmoke).toBe(false);
    expect(result.targetDir).toBe(reportsDir);
    expect(result.finalReportPath).toBe(path.join(reportsDir, 'ablation-d-report.json'));
    expect(result.partialReportPath).toBe(path.join(reportsDir, 'partial-ablation-d.json'));
  });
});
