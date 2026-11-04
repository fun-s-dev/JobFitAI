import { useQuery } from '@tanstack/react-query';
import { getReportGithubLinks } from '../services/verification.api';

/**
 * Repositories linked to a report (persisted server-side), so they survive a page reload.
 * `verifiedAnalysisIds` is what verification is started with.
 */
export function useGithubLinks(reportId) {
  const query = useQuery({
    queryKey: ['githubLinks', reportId],
    queryFn: () => getReportGithubLinks(reportId),
    enabled: Boolean(reportId),
    staleTime: 15000,
  });
  const links = query.data?.links || [];
  return {
    data: query.data,
    links,
    verifiedAnalysisIds: links.filter((l) => l.verified).map((l) => l.analysisId),
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
