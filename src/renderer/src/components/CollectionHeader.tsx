// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { SMAPI_MOD_ID, type PlannedMod, type ProfileState } from '@shared/types';
import { formatBytes, plural } from '../lib/format';
import { playReadiness, profileStats, profileStatus, startLabel } from '../lib/profile';
import { useActions } from '../hooks/useActions';
import { ConfirmDialog } from './ConfirmDialog';
import { Icon } from './Icon';
import { StatusChip } from './StatusChip';

interface CollectionHeaderProps {
  profile: ProfileState;
  hasApiKey: boolean;
  /** Nexus refused the saved key: installs can't start until a new one is entered. */
  keyRejected: boolean;
  /** The collection is being resolved or updated: Start, Play and Remove wait for it. */
  updating: boolean;
  onBack: () => void;
  onRemoved: () => void;
}

type Dialog = 'none' | 'remove' | 'play';

/** Something Start/Resume would act on: unfinished or failed mods, or an outdated-SMAPI row to re-check. */
function isResumable(m: PlannedMod): boolean {
  if (!m.selected) return false;
  if (m.status === 'manual') return m.modId === SMAPI_MOD_ID;
  return m.status !== 'installed' && m.status !== 'skipped';
}

/** Title block plus Start/Pause, Play, Reveal and Remove (with confirmations). */
export function CollectionHeader({ profile, hasApiKey, keyRejected, updating, onBack, onRemoved }: CollectionHeaderProps) {
  const { run, notify } = useActions();
  const [dialog, setDialog] = useState<Dialog>('none');
  const stats = profileStats(profile);
  const status = profileStatus(profile);
  const readiness = playReadiness(profile);
  const { slug, name } = profile;
  const resumable = profile.mods.some(isResumable);

  const launch = async (): Promise<void> => {
    setDialog('none');
    const r = await run(`Couldn't start Stardew Valley`, (api) => api.launchGame(slug));
    if (r.ok) notify(`Starting Stardew Valley with "${name}"…`, 'success');
  };
  const remove = async (): Promise<void> => {
    setDialog('none');
    const r = await run(`Couldn't remove "${name}"`, (api) => api.removeProfile(slug));
    if (r.ok) {
      notify(`Removed "${name}"`, 'success');
      onRemoved();
    }
  };

  return (
    <header className="collection-header">
      <button type="button" className="btn btn-quiet back-btn" onClick={onBack}>
        <Icon name="back" size={16} /> All collections
      </button>
      <div className="collection-title">
        <h1>{name}</h1>
        <StatusChip tone={status.tone} label={status.text} />
      </div>
      <p className="muted">
        by {profile.author} · revision {profile.revision} · {plural(stats.total, 'mod')} · {formatBytes(profile.totalSize)}
      </p>
      <div className="btn-row collection-actions">
        {profile.running ? (
          <button type="button" className="btn btn-secondary" onClick={() => void run("Couldn't pause", (api) => api.pauseInstall(slug))}>
            <Icon name="pause" size={14} /> Pause
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!hasApiKey || keyRejected || updating || readiness === 'ready' || !resumable}
            onClick={() => void run("Couldn't start installing", (api) => api.startInstall(slug))}
          >
            <Icon name="play" size={14} /> {startLabel(profile)}
          </button>
        )}
        <button
          type="button"
          className={readiness === 'ready' ? 'btn btn-primary btn-play' : 'btn btn-secondary'}
          disabled={readiness === 'incomplete' || updating}
          onClick={() => (readiness === 'partial' ? setDialog('play') : void launch())}
        >
          <Icon name="play" size={14} /> Play
        </button>
        <button type="button" className="btn btn-quiet" onClick={() => void run("Couldn't open Finder", (api) => api.revealProfile(slug))}>
          <Icon name="folder" size={14} /> Reveal in Finder
        </button>
        <button type="button" className="btn btn-quiet btn-danger-text" onClick={() => setDialog('remove')} disabled={updating}>
          <Icon name="trash" size={14} /> Remove
        </button>
      </div>
      {updating && (
        <p className="muted small" role="status">
          Updating this collection… Start, Play and Remove are back once it&apos;s done.
        </p>
      )}
      {!hasApiKey && <p className="field-error">Add your Nexus API key in Settings before installing.</p>}
      {hasApiKey && keyRejected && <p className="field-error">Nexus Mods rejected your saved API key. Enter a new one in Settings before installing.</p>}
      {readiness === 'incomplete' && !profile.running && stats.installed < stats.selected && (
        <p className="muted small">Play unlocks once the mods are installed.</p>
      )}

      <ConfirmDialog open={dialog === 'remove'} title={`Remove "${name}"?`} confirmLabel="Remove collection" danger onConfirm={() => void remove()} onCancel={() => setDialog('none')}>
        <p>This deletes this collection&apos;s own Mods folder and downloads. Your regular Stardew Valley Mods folder and your saves are not touched.</p>
      </ConfirmDialog>
      <ConfirmDialog open={dialog === 'play'} title="Play with missing mods?" confirmLabel="Play anyway" onConfirm={() => void launch()} onCancel={() => setDialog('none')}>
        <p>
          {plural(stats.failed + stats.manual, 'mod')} didn&apos;t install. The game may still run, but other mods that depend on them can be skipped or misbehave.
        </p>
      </ConfirmDialog>
    </header>
  );
}
