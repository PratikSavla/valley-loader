// SPDX-License-Identifier: AGPL-3.0-only
import type { ProfileState } from '@shared/types';
import { formatBytes } from '../lib/format';
import { playReadiness, profileStats, profileStatus } from '../lib/profile';
import { availableUpdate } from '../lib/updates';
import { Icon } from './Icon';
import { StatusChip } from './StatusChip';

interface ProfileCardProps {
  profile: ProfileState;
  onOpen: () => void;
  onPlay: () => void;
}

export function ProfileCard({ profile, onOpen, onPlay }: ProfileCardProps) {
  const stats = profileStats(profile);
  const status = profileStatus(profile);
  const ready = playReadiness(profile) === 'ready';
  const update = availableUpdate(profile);
  const pct = stats.selected > 0 ? Math.round((stats.installed / stats.selected) * 100) : 0;
  return (
    <li className="profile-card">
      <div className="profile-tile" aria-hidden="true">
        {profile.tileImageUrl ? <img src={profile.tileImageUrl} alt="" loading="lazy" /> : <Icon name="leaf" size={34} />}
      </div>
      <div className="profile-main">
        <h3>{profile.name}</h3>
        <p className="muted small">
          by {profile.author} · revision {profile.revision} · {formatBytes(profile.totalSize)}
        </p>
        <div className="profile-progress">
          <progress max={Math.max(stats.selected, 1)} value={stats.installed} aria-label={`${profile.name} install progress`} />
          <span className="small">
            {stats.installed} of {stats.selected} installed ({pct}%)
          </span>
        </div>
      </div>
      <div className="profile-side">
        <StatusChip tone={status.tone} label={status.text} />
        {update && (
          <span className="badge badge-update">
            <Icon name="refresh" size={12} /> Update available (revision {update.latestRevision})
          </span>
        )}
        <div className="btn-row">
          <button type="button" className="btn btn-secondary" onClick={onOpen}>
            {ready ? 'Open' : 'Continue'}
            <span className="sr-only"> {profile.name}</span>
          </button>
          <button type="button" className="btn btn-primary" onClick={onPlay} disabled={!ready}>
            <Icon name="play" size={14} />
            Play<span className="sr-only"> {profile.name}</span>
          </button>
        </div>
      </div>
    </li>
  );
}
