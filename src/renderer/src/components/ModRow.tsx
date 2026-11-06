// SPDX-License-Identifier: AGPL-3.0-only
import { SMAPI_MOD_ID, type PlannedMod } from '@shared/types';
import { formatProgress, percent, sourceLabel, statusLabel, statusTone } from '../lib/format';
import { useActions } from '../hooks/useActions';
import { ExternalLink } from './ExternalLink';
import { StatusChip } from './StatusChip';

const FILE_PICKABLE = new Set<PlannedMod['sourceType']>(['manual', 'browse']);

function ModProgress({ mod }: { mod: PlannedMod }) {
  if (!mod.progress || mod.status !== 'downloading') return null;
  const { received, total } = mod.progress;
  const pct = percent(received, total);
  return (
    <div className="mod-progress">
      <progress max={total > 0 ? total : undefined} value={total > 0 ? received : undefined} aria-label={`Downloading ${mod.name}`} />
      <span className="small muted">
        {formatProgress(received, total)}
        {pct !== undefined ? ` · ${pct}%` : ''}
      </span>
    </div>
  );
}

function ModNotes({ mod }: { mod: PlannedMod }) {
  return (
    <>
      {mod.warnings.length > 0 && (
        <details className="mod-warnings">
          <summary>{mod.warnings.length === 1 ? '1 note' : `${mod.warnings.length} notes`}</summary>
          <ul>
            {mod.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      {mod.instructions && (mod.status === 'manual' || mod.sourceType === 'manual') && (
        <details className="mod-warnings" open={mod.status === 'manual'}>
          <summary>Author&apos;s instructions</summary>
          <p className="plain-text">{mod.instructions}</p>
        </details>
      )}
      {mod.error && (
        <p className="mod-error" role="note">
          {mod.error}
        </p>
      )}
    </>
  );
}

/** One row of the mod table. All author-supplied text is rendered as plain text. */
export function ModRow({ slug, mod, position }: { slug: string; mod: PlannedMod; position: number }) {
  const { run } = useActions();
  const canPick = FILE_PICKABLE.has(mod.sourceType) && mod.status !== 'installed' && mod.selected;
  // SMAPI is never downloaded: its row only says whether the installed SMAPI is new enough, so "retry" re-checks it.
  const smapiOutdated = mod.modId === SMAPI_MOD_ID && mod.status === 'manual';
  const canRetry = mod.status === 'failed' || smapiOutdated;
  return (
    <tr className={mod.selected ? `mod-row tone-${statusTone(mod.status)}` : 'mod-row is-skipped'}>
      <td className="col-num">{position}</td>
      <td className="col-name">
        <span className="mod-name">{mod.name}</span>
        <span className="muted small">
          {' '}
          v{mod.version}
          {mod.author ? ` · ${mod.author}` : ''}
          {mod.optional ? ' · optional' : ''}
        </span>
        <ModNotes mod={mod} />
      </td>
      <td className="col-source">
        <span className={`badge badge-${mod.sourceType}`}>{sourceLabel(mod.sourceType)}</span>
      </td>
      <td className="col-status">
        <StatusChip tone={statusTone(mod.status)} label={smapiOutdated ? 'Update SMAPI' : statusLabel(mod.status)} />
        <ModProgress mod={mod} />
      </td>
      <td className="col-actions">
        {canRetry && (
          <button type="button" className="btn btn-secondary btn-small" onClick={() => void run(`Couldn't retry "${mod.name}"`, (api) => api.retryMod(slug, mod.key))}>
            {smapiOutdated ? 'Check again' : 'Retry'}
            <span className="sr-only"> {mod.name}</span>
          </button>
        )}
        {canPick && (
          <button type="button" className="btn btn-secondary btn-small" onClick={() => void run(`Couldn't install a file for "${mod.name}"`, (api) => api.pickManualFile(slug, mod.key))}>
            Pick file…<span className="sr-only"> for {mod.name}</span>
          </button>
        )}
        {canPick && mod.url && <ExternalLink href={mod.url}>Download page</ExternalLink>}
      </td>
    </tr>
  );
}
