import { useMutation, useQueryClient } from '@tanstack/react-query';
import { updateClaimOverride } from '../services/verification.api';

/**
 * Mutation hook for candidate claim decision overrides with optimistic UI and rollback.
 *
 * @param {string} reportId
 */
export function useClaimDecision(reportId) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ claimId, decision }) => {
      return await updateClaimOverride(claimId, decision);
    },

    // Optimistic Update
    onMutate: async ({ claimId, decision }) => {
      // Cancel outgoing refetches so they don't overwrite optimistic update
      await queryClient.cancelQueries({ queryKey: ['verification', reportId] });

      // Snapshot previous verification data for rollback
      const previousVerification = queryClient.getQueryData(['verification', reportId]);

      // Optimistically update claims array in cache
      if (previousVerification && Array.isArray(previousVerification.claims)) {
        queryClient.setQueryData(['verification', reportId], (old) => {
          if (!old || !old.claims) return old;
          return {
            ...old,
            claims: old.claims.map((claim) => {
              const currentId = claim.id || claim._id;
              if (currentId === claimId) {
                return {
                  ...claim,
                  userOverride: {
                    decision,
                    at: new Date().toISOString(),
                  },
                };
              }
              return claim;
            }),
          };
        });
      }

      return { previousVerification };
    },

    // Rollback on Error
    onError: (_err, _variables, context) => {
      if (context?.previousVerification) {
        queryClient.setQueryData(['verification', reportId], context.previousVerification);
      }
    },

    // Always re-sync with server on settled
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['verification', reportId] });
      queryClient.invalidateQueries({ queryKey: ['groundedDraft', reportId] });
    },
  });
}
