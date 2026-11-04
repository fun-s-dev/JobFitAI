import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { setGithubLinkProject } from '../services/verification.api';
import { getApiErrorMessage } from '../../../services/apiError';

const noteStyle = { fontSize: '0.85rem', color: '#9aa4b2', margin: '0.5rem 0' };
const errorStyle = { color: '#ff6b6b', fontSize: '0.9rem', margin: '0.5rem 0' };

/**
 * The repositories linked to this report and the draft project each one belongs to.
 *
 * A repository's evidence only supports the claims of the project it is assigned to. Matching by
 * name is automatic; when the names differ (for example "Backend Ledger" and the repository
 * "Banking-System-backend") the user chooses the project here.
 *
 * @param {object} props
 * @param {string} props.reportId
 * @param {{ links: Array, draftProjects: string[], hasDraft: boolean }|undefined} props.data
 */
export default function GithubProjectLinks({ reportId, data }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);

  const assign = useMutation({
    mutationFn: ({ analysisId, projectName }) => setGithubLinkProject(reportId, analysisId, projectName),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ['githubLinks', reportId] });
    },
    onError: (err) => setError(getApiErrorMessage(err, 'Could not save the project for this repository.')),
  });

  const links = data?.links || [];
  if (links.length === 0) return null;

  const projects = data?.draftProjects || [];
  const hasDraft = Boolean(data?.hasDraft);

  return (
    <div data-testid='github-project-links' style={{ margin: '1rem 0' }}>
      <h4 style={{ margin: '0 0 0.25rem 0' }}>Linked repositories</h4>
      <p style={noteStyle}>
        A repository only supports the claims of the project it belongs to. Choose the project for each
        repository below when the names do not match.
      </p>

      {!hasDraft && (
        <p style={noteStyle} data-testid='links-need-draft'>
          Generate the resume draft first. Then you can match each repository to a project in it.
        </p>
      )}

      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {links.map((link) => {
          const selectId = `project-for-${link.analysisId}`;
          return (
            <li key={link.analysisId} style={{ margin: '0.6rem 0' }}>
              <div>
                <strong>{link.repositoryFullName}</strong>{' '}
                {!link.verified && <small style={{ color: '#e0a458' }}>(ownership not verified, not counted)</small>}
              </div>

              {link.verified && hasDraft && (
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <label htmlFor={selectId}>Belongs to project</label>
                  <select
                    id={selectId}
                    value={link.explicitProjectName || ''}
                    disabled={assign.isPending}
                    onChange={(e) =>
                      assign.mutate({ analysisId: link.analysisId, projectName: e.target.value || null })
                    }
                  >
                    <option value=''>
                      {link.matchSource === 'name' ? `Automatic (${link.matchedProject})` : 'Automatic (no match)'}
                    </option>
                    {projects.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {link.verified && hasDraft && (
                <div style={link.matchedProject ? { ...noteStyle, color: '#34d399' } : { ...noteStyle, color: '#e0a458' }}>
                  {link.matchedProject
                    ? `Used as evidence for: ${link.matchedProject}`
                    : 'Not matched to a project in your draft yet, so it is not used as evidence.'}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {error && (
        <p role='alert' style={errorStyle}>
          {error}
        </p>
      )}
    </div>
  );
}
