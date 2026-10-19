import { useQuery } from '@tanstack/react-query';
import { getJobById } from '../services/verification.api';

/**
 * Hook to poll a background verification job every 2s until done or failed.
 *
 * @param {string|null} jobId
 * @param {object} [options]
 * @param {Function} [options.onDone] - Callback when job status turns 'done'
 * @param {Function} [options.onFailed] - Callback when job status turns 'failed'
 */
export function useJob(jobId, { onDone, onFailed } = {}) {
  const query = useQuery({
    queryKey: ['job', jobId],
    queryFn: async () => {
      const data = await getJobById(jobId);
      const job = data.job;

      if (job.status === 'done' && typeof onDone === 'function') {
        onDone(job);
      } else if (job.status === 'failed' && typeof onFailed === 'function') {
        onFailed(job);
      }

      return job;
    },
    enabled: Boolean(jobId),
    refetchInterval: (queryState) => {
      const currentJob = queryState.state.data;
      if (!currentJob) return 2000;
      if (currentJob.status === 'done' || currentJob.status === 'failed') {
        return false;
      }
      return 2000; // poll every 2 seconds
    },
    refetchIntervalInBackground: true,
  });

  const job = query.data;
  const isRunning = job?.status === 'queued' || job?.status === 'running';
  const isDone = job?.status === 'done';
  const isFailed = job?.status === 'failed';

  const doneCount = job?.progress?.done || 0;
  const totalCount = job?.progress?.total || 0;
  const progressText =
    totalCount > 0
      ? `Claim ${doneCount} of ${totalCount}`
      : isRunning
      ? 'Initializing verification...'
      : '';

  const progressPercent =
    totalCount > 0 ? Math.min(100, Math.round((doneCount / totalCount) * 100)) : isRunning ? 5 : 0;

  return {
    job,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error || (isFailed ? job?.error : null),
    isRunning,
    isDone,
    isFailed,
    doneCount,
    totalCount,
    progressText,
    progressPercent,
    refetch: query.refetch,
  };
}
