import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getVerificationRun, getGroundedDraft } from '../services/verification.api';

/**
 * Hook to fetch verification run results, claims, and grounded draft exclusion info.
 * Includes friendly server wake-up detection for free-tier spin-up delays.
 *
 * @param {string} reportId
 * @param {string|null} [runId=null]
 */
export function useVerification(reportId, runId = null) {
  const [isWakingUp, setIsWakingUp] = useState(false);

  // Verification Run & Claims Query
  const verificationQuery = useQuery({
    queryKey: ['verification', reportId, runId],
    queryFn: async () => {
      try {
        return await getVerificationRun(reportId, runId);
      } catch (err) {
        if (err.response?.status === 404) {
          // No verification run exists yet for this report
          return { run: null, claims: [] };
        }
        throw err;
      }
    },
    enabled: Boolean(reportId),
    staleTime: 30000,
  });

  // Grounded Draft Exclusion Info Query
  const groundedQuery = useQuery({
    queryKey: ['groundedDraft', reportId, runId],
    queryFn: async () => {
      try {
        return await getGroundedDraft(reportId, runId);
      } catch (err) {
        if (err.response?.status === 404) {
          return null;
        }
        throw err;
      }
    },
    enabled: Boolean(reportId && verificationQuery.data?.run),
    staleTime: 30000,
  });

  // Detect slow initial loading (>3.5s) to display friendly wake-up message
  useEffect(() => {
    let timer;
    if (verificationQuery.isLoading) {
      timer = setTimeout(() => {
        setIsWakingUp(true);
      }, 3500);
    } else {
      setIsWakingUp(false);
    }
    return () => clearTimeout(timer);
  }, [verificationQuery.isLoading]);

  const run = verificationQuery.data?.run || null;
  const claims = verificationQuery.data?.claims || [];
  const grounded = groundedQuery.data || null;

  return {
    run,
    claims,
    grounded,
    isLoading: verificationQuery.isLoading,
    isWakingUp,
    isError: verificationQuery.isError,
    error: verificationQuery.error,
    refetch: () => {
      verificationQuery.refetch();
      groundedQuery.refetch();
    },
  };
}
