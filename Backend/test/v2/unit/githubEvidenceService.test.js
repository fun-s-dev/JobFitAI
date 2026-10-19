import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createGitHubEvidenceService } = require('../../../src/v2/services/githubEvidence.service');

describe('services/githubEvidence.service (unit)', () => {
  let mockAnalysisModel;
  let mockLinkModel;
  let mockClient;

  beforeEach(() => {
    mockAnalysisModel = {
      findOne: vi.fn(),
      findOneAndUpdate: vi.fn(),
      updateMany: vi.fn(),
    };
    mockLinkModel = {
      findOneAndUpdate: vi.fn(),
    };
    mockClient = {
      getRepoMetadata: vi.fn(),
      listLanguages: vi.fn(),
      getHeadCommitSha: vi.fn(),
      getTree: vi.fn(),
      getBlobContent: vi.fn(),
    };
  });

  it('rejects invalid GitHub repository URLs immediately without calling GitHub API', async () => {
    const service = createGitHubEvidenceService({
      githubClient: mockClient,
      GithubAnalysis: mockAnalysisModel,
      ReportProjectLink: mockLinkModel,
    });

    await expect(
      service.analyzeRepository({
        repoUrl: 'https://evil.com/owner/repo',
        reportId: '507f1f77bcf86cd799439011',
        userId: '507f1f77bcf86cd799439022',
      })
    ).rejects.toThrow(/github\.com/i);

    expect(mockClient.getRepoMetadata).not.toHaveBeenCalled();
  });

  it('serves cached analysis on cache hit and makes ZERO git/blob calls', async () => {
    const existingAnalysis = {
      _id: '507f1f77bcf86cd799439099',
      repositoryFullName: 'fun-s-dev/JobFitAI',
      commitSha: 'sha999',
      analysisStatus: 'complete',
      evidenceItems: [{ skill: 'Express', strength: 0.8 }],
    };

    mockClient.getRepoMetadata.mockResolvedValue({
      notModified: false,
      data: { private: false, archived: false, size: 1000, default_branch: 'main' },
    });
    mockClient.getHeadCommitSha.mockResolvedValue('sha999');
    mockAnalysisModel.findOne.mockResolvedValue(existingAnalysis);
    mockLinkModel.findOneAndUpdate.mockResolvedValue({});

    const service = createGitHubEvidenceService({
      githubClient: mockClient,
      GithubAnalysis: mockAnalysisModel,
      ReportProjectLink: mockLinkModel,
    });

    const result = await service.analyzeRepository({
      repoUrl: 'https://github.com/fun-s-dev/JobFitAI',
      reportId: '507f1f77bcf86cd799439011',
      userId: '507f1f77bcf86cd799439022',
    });

    expect(result.cached).toBe(true);
    expect(result.analysis._id).toBe('507f1f77bcf86cd799439099');
    expect(mockClient.getTree).not.toHaveBeenCalled();
    expect(mockClient.getBlobContent).not.toHaveBeenCalled();
    expect(mockLinkModel.findOneAndUpdate).toHaveBeenCalled();
  });

  it('rejects private repositories', async () => {
    mockClient.getRepoMetadata.mockResolvedValue({
      notModified: false,
      data: { private: true, archived: false, size: 1000, default_branch: 'main' },
    });

    const service = createGitHubEvidenceService({
      githubClient: mockClient,
      GithubAnalysis: mockAnalysisModel,
      ReportProjectLink: mockLinkModel,
    });

    await expect(
      service.analyzeRepository({
        repoUrl: 'https://github.com/fun-s-dev/secret-repo',
        reportId: '507f1f77bcf86cd799439011',
        userId: '507f1f77bcf86cd799439022',
      })
    ).rejects.toThrow(/private/i);
  });

  it('performs full extraction and AST scan on cache miss and persists results', async () => {
    mockClient.getRepoMetadata.mockResolvedValue({
      notModified: false,
      data: { private: false, archived: false, size: 500, default_branch: 'main' },
    });
    mockClient.getHeadCommitSha.mockResolvedValue('sha100');
    mockClient.listLanguages.mockResolvedValue({ JavaScript: 5000 });
    mockAnalysisModel.findOne.mockResolvedValue(null);

    mockClient.getTree.mockResolvedValue({
      truncated: false,
      tree: [
        { path: 'package.json', type: 'blob', size: 150, sha: 's1' },
        { path: 'src/routes/auth.js', type: 'blob', size: 300, sha: 's2' },
        { path: 'README.md', type: 'blob', size: 200, sha: 's3' },
      ],
    });

    mockClient.getBlobContent.mockImplementation(({ fileSha }) => {
      if (fileSha === 's1') {
        return JSON.stringify({ dependencies: { express: '^4.18.0' } });
      }
      if (fileSha === 's2') {
        return `
const router = require('express').Router();
router.post('/login', (req, res) => res.send('ok'));
        `;
      }
      if (fileSha === 's3') {
        return '# JobFitAI\nBuilt with Express and Redis.';
      }
      return '';
    });

    const savedDoc = {
      _id: '507f1f77bcf86cd799439088',
      analysisStatus: 'complete',
    };
    mockAnalysisModel.findOneAndUpdate.mockResolvedValue(savedDoc);
    mockLinkModel.findOneAndUpdate.mockResolvedValue({});

    const service = createGitHubEvidenceService({
      githubClient: mockClient,
      GithubAnalysis: mockAnalysisModel,
      ReportProjectLink: mockLinkModel,
    });

    const result = await service.analyzeRepository({
      repoUrl: 'https://github.com/fun-s-dev/JobFitAI',
      reportId: '507f1f77bcf86cd799439011',
      userId: '507f1f77bcf86cd799439022',
    });

    expect(result.cached).toBe(false);
    expect(mockAnalysisModel.findOneAndUpdate).toHaveBeenCalled();
    const saveCall = mockAnalysisModel.findOneAndUpdate.mock.calls[0][1];
    expect(saveDocSkills(saveCall)).toContain('Express');
    expect(saveDocSkills(saveCall)).toContain('REST APIs');
    const items = saveCall.$set ? saveCall.$set.evidenceItems : saveCall.evidenceItems;
    const redisItem = items.find((i) => i.skill === 'Redis');
    expect(redisItem).toBeDefined();
    expect(redisItem.contradiction).toBe(true);
  });
});

function saveDocSkills(saveCall) {
  const items = saveCall.$set ? saveCall.$set.evidenceItems : saveCall.evidenceItems;
  return (items || []).map((i) => i.skill);
}
