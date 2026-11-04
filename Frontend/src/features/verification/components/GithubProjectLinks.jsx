import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { setGithubLinkProject, updateGithubProjectDetails } from '../services/verification.api';
import { getApiErrorMessage } from '../../../services/apiError';

/**
 * The name shown on the resume for a repository, with a Save button.
 * Works for any verified repository: a project written from it, or a resume project it is assigned to.
 */
function NameField({ link, onSave, isSaving }) {
  const [name, setName] = useState(link.displayName || '');
  const dirty = name.trim() !== (link.displayName || '');
  const inputId = `name-${link.analysisId}`;

  return (
    <div className='project-card__row'>
      <label htmlFor={inputId} className='vp-label'>Name on your resume</label>
      <input
        id={inputId}
        type='text'
        className='vp-input'
        value={name}
        maxLength={100}
        placeholder={link.defaultName}
        onChange={(e) => setName(e.target.value)}
        disabled={isSaving}
      />
      <button
        type='button'
        className='vp-btn vp-btn--secondary'
        disabled={!dirty || isSaving}
        onClick={() => onSave({ analysisId: link.analysisId, details: { displayName: name.trim() ? name : null } })}
      >
        Save name
      </button>
    </div>
  );
}

/**
 * One project written from a selected repository: its name on the resume, and the confirmation that the
 * user built it. Owning a repository does not show that you wrote its code, so the project is only included
 * in the exported resume after "I built this project" is ticked.
 */
function GithubProjectCard({ link, onSave, isSaving }) {
  const effectiveName = link.displayName || link.defaultName;

  return (
    <li
      className={`project-card${link.authorshipConfirmed ? ' project-card--confirmed' : ''}`}
      data-testid={`github-project-${link.analysisId}`}
    >
      <div className='project-card__head'>
        <span className='project-card__title'>{effectiveName}</span>
        <span className='project-card__repo'>from {link.repositoryFullName}</span>
      </div>

      <NameField link={link} onSave={onSave} isSaving={isSaving} />

      <label className='project-card__confirm'>
        <input
          type='checkbox'
          className='vp-switch'
          checked={link.authorshipConfirmed}
          disabled={isSaving}
          onChange={(e) => onSave({ analysisId: link.analysisId, details: { authorshipConfirmed: e.target.checked } })}
          aria-label={`I built ${effectiveName}`}
        />
        <span>
          <span className='project-card__confirm-title'>I built this project</span>
          <span className='project-card__confirm-note'>
            Owning a repository does not show that you wrote its code, so this project is only included in your
            resume after you confirm it.
          </span>
        </span>
      </label>

      {!link.authorshipConfirmed && (
        <div className='vp-alert vp-alert--warning' data-testid={`not-confirmed-${link.analysisId}`}>
          <span className='vp-alert__icon' aria-hidden='true'>⚠</span>
          <span className='vp-alert__body'>
            Not confirmed yet: this project will not appear in your exported resume.
          </span>
        </div>
      )}
    </li>
  );
}

/**
 * The repositories linked to this report.
 *
 * - Repositories chosen under "Best projects for this job" are your GitHub projects: you name them and
 *   confirm that you built them.
 * - Any other linked repository supports the claims of a resume project it is assigned to. You can give that
 *   project a different name on the resume too.
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
    <div data-testid='github-project-links' className='projects-section'>
      {githubProjects.length > 0 && (
        <div data-testid='github-projects' className='projects-section'>
          <hr className='vp-panel__divider' />
          <div>
            <h3 className='vp-panel__sub'>Your GitHub projects</h3>
            <p className='vp-panel__desc'>
              When you generate the resume draft, its Projects section is written from these repositories (from
              their README, description and technology stack only). Each project is then checked against its own
              repository.
            </p>
          </div>
          <ul className='project-list'>
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
        <div data-testid='other-linked-repos' className='projects-section'>
          <hr className='vp-panel__divider' />
          <div>
            <h3 className='vp-panel__sub'>Other linked repositories</h3>
            <p className='vp-panel__desc'>
              A repository only supports the claims of the project it belongs to. Choose the project for each
              repository below when the names do not match. You can also change the name that project has on your
              resume.
            </p>
          </div>

          {!hasDraft && (
            <div className='vp-alert vp-alert--info' data-testid='links-need-draft'>
              <span className='vp-alert__icon' aria-hidden='true'>ℹ</span>
              <span className='vp-alert__body'>
                Generate the resume draft first. Then you can match each repository to a project in it.
              </span>
            </div>
          )}

          <ul className='project-list'>
            {otherLinks.map((link) => {
              const selectId = `project-for-${link.analysisId}`;
              return (
                <li key={`${link.analysisId}:${link.displayName || ''}`} className='link-row'>
                  <span className='link-row__name'>
                    {link.repositoryFullName}{' '}
                    {!link.verified && <small className='link-row__status link-row__status--warn'>(ownership not verified, not counted)</small>}
                  </span>

                  {link.verified && hasDraft && (
                    <div className='link-row__controls'>
                      <label htmlFor={selectId} className='vp-label'>Belongs to project</label>
                      <select
                        id={selectId}
                        className='link-row__select'
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
                    <span className={`link-row__status ${link.matchedProject ? 'link-row__status--ok' : 'link-row__status--warn'}`}>
                      {link.matchedProject
                        ? `Used as evidence for: ${link.matchedProject}`
                        : 'Not matched to a project in your draft yet, so it is not used as evidence.'}
                    </span>
                  )}

                  {link.verified && link.matchedProject && (
                    <NameField link={link} onSave={(vars) => saveDetails.mutate(vars)} isSaving={saveDetails.isPending} />
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {error && (
        <div className='vp-alert vp-alert--error' role='alert'>
          <span className='vp-alert__icon' aria-hidden='true'>⚠</span>
          <span className='vp-alert__body'>{error}</span>
        </div>
      )}
    </div>
  );
}
