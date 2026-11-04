import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { setGithubLinkProject, updateGithubProjectDetails } from '../services/verification.api';
import { getApiErrorMessage } from '../../../services/apiError';

const noteStyle = { fontSize: '0.85rem', color: '#9aa4b2', margin: '0.5rem 0' };
const errorStyle = { color: '#ff6b6b', fontSize: '0.9rem', margin: '0.5rem 0' };

/**
 * One selected GitHub project: the name shown on the resume, and the confirmation that the user built it.
 *
 * Owning a repository does not show that you wrote its code, so the project is only exported after
 * "I built this project" is ticked. The name can be changed at any time without verifying again.
 */
function GithubProjectCard({ link, onSave, isSaving }) {
  const [name, setName] = useState(link.displayName || '');
  const effectiveName = link.displayName || link.defaultName;
  const dirty = name.trim() !== (link.displayName || '');

  return (
    <li data-testid={`github-project-${link.analysisId}`} style={{ margin: '0.9rem 0', padding: '0.75rem', border: '1px solid #2a3140', borderRadius: 8 }}>
      <div>
        <strong>{effectiveName}</strong> <small style={{ color: '#9aa4b2' }}>from {link.repositoryFullName}</small>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '0.5rem' }}>
        <label htmlFor={`name-${link.analysisId}`}>Name on your resume</label>
        <input
          id={`name-${link.analysisId}`}
          type='text'
          value={name}
          maxLength={100}
          placeholder={link.defaultName}
          onChange={(e) => setName(e.target.value)}
          disabled={isSaving}
        />
        <button
          type='button'
          className='button secondary-button'
          disabled={!dirty || isSaving}
          onClick={() => onSave({ analysisId: link.analysisId, details: { displayName: name.trim() ? name : null } })}
        >
          Save name
        </button>
      </div>

      <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', marginTop: '0.6rem' }}>
        <input
          type='checkbox'
          checked={link.authorshipConfirmed}
          disabled={isSaving}
          onChange={(e) => onSave({ analysisId: link.analysisId, details: { authorshipConfirmed: e.target.checked } })}
          aria-label={`I built ${effectiveName}`}
        />
        <span>
          I built this project
          <span style={{ fontSize: '0.85rem', color: '#9aa4b2' }}>
            {' '}
            Owning a repository does not show that you wrote its code, so this project is only included in your
            resume after you confirm it.
          </span>
        </span>
      </label>

      {!link.authorshipConfirmed && (
        <p style={{ ...noteStyle, color: '#e0a458' }} data-testid={`not-confirmed-${link.analysisId}`}>
          Not confirmed yet: this project will not appear in your exported resume.
        </p>
      )}
    </li>
  );
}

/**
 * The repositories linked to this report.
 *
 * - Repositories chosen under "Best projects for this job" are your GitHub projects: you name them and
 *   confirm that you built them.
 * - Any other linked repository only supports the claims of a resume project it is assigned to.
 *
 * @param {object} props
 * @param {string} props.reportId
 * @param {{ links: Array, draftProjects: string[], hasDraft: boolean }|undefined} props.data
 */
export default function GithubProjectLinks({ reportId, data }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['githubLinks', reportId] });
    queryClient.invalidateQueries({ queryKey: ['groundedDraft'] }); // what the export includes may have changed
  };

  const assign = useMutation({
    mutationFn: ({ analysisId, projectName }) => setGithubLinkProject(reportId, analysisId, projectName),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(getApiErrorMessage(err, 'Could not save the project for this repository.')),
  });

  const saveDetails = useMutation({
    mutationFn: ({ analysisId, details }) => updateGithubProjectDetails(reportId, analysisId, details),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(getApiErrorMessage(err, 'Could not save the project details.')),
  });

  const links = data?.links || [];
  if (links.length === 0) return null;

  const projects = data?.draftProjects || [];
  const hasDraft = Boolean(data?.hasDraft);
  const githubProjects = links.filter((l) => l.verified && l.selected);
  const otherLinks = links.filter((l) => !(l.verified && l.selected));

  return (
    <div data-testid='github-project-links' style={{ margin: '1rem 0' }}>
      {githubProjects.length > 0 && (
        <div data-testid='github-projects'>
          <h4 style={{ margin: '0 0 0.25rem 0' }}>Your GitHub projects</h4>
          <p style={noteStyle}>
            When you generate the resume draft, its Projects section is written from these repositories (from
            their README, description and technology stack only). Each project is then checked against its own
            repository.
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {githubProjects.map((link) => (
              <GithubProjectCard
                key={`${link.analysisId}:${link.displayName || ''}`}
                link={link}
                onSave={(vars) => saveDetails.mutate(vars)}
                isSaving={saveDetails.isPending}
              />
            ))}
          </ul>
        </div>
      )}

      {otherLinks.length > 0 && (
        <div data-testid='other-linked-repos'>
          <h4 style={{ margin: '1rem 0 0.25rem 0' }}>Other linked repositories</h4>
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
            {otherLinks.map((link) => {
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
                        onChange={(e) => assign.mutate({ analysisId: link.analysisId, projectName: e.target.value || null })}
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
        </div>
      )}

      {error && (
        <p role='alert' style={errorStyle}>
          {error}
        </p>
      )}
    </div>
  );
}
