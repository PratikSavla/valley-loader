// SPDX-License-Identifier: AGPL-3.0-only
import type { ProfileStats } from '../lib/profile';
import { STATUS_ORDER, formatBytes, statusLabel, statusTone } from '../lib/format';
import { StatusChip } from './StatusChip';

/** Overall progress plus a chip per status that has mods. The sentence is a polite live region. */
export function SummaryBar({ stats }: { stats: ProfileStats }) {
  const present = STATUS_ORDER.filter((s) => stats.counts[s] > 0);
  return (
    <section className="summary-bar" aria-label="Install summary">
      <div className="summary-progress">
        <p aria-live="polite" aria-atomic="true">
          <strong>{stats.installed}</strong> of {stats.selected} mods installed
          <span className="muted"> · {formatBytes(stats.selectedBytes)} to download in total</span>
        </p>
        <progress max={Math.max(stats.selected, 1)} value={stats.installed} aria-label="Collection install progress" />
      </div>
      <ul className="summary-chips" aria-label="Mods by status">
        {present.map((status) => (
          <li key={status}>
            <StatusChip tone={statusTone(status)} label={`${statusLabel(status)}: ${stats.counts[status]}`} />
          </li>
        ))}
      </ul>
    </section>
  );
}
