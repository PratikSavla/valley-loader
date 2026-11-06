// SPDX-License-Identifier: AGPL-3.0-only
import type { PlannedMod } from '@shared/types';
import { formatBytes } from '../lib/format';
import { useActions } from '../hooks/useActions';

/** Toggles for optional mods. Unchecked mods are skipped. */
export function OptionalMods({ slug, mods }: { slug: string; mods: readonly PlannedMod[] }) {
  const { run } = useActions();
  const optional = mods.filter((m) => m.optional);
  if (optional.length === 0) return null;
  const toggle = (mod: PlannedMod, selected: boolean): void => {
    void run(`Couldn't update "${mod.name}"`, (api) => api.setModSelected(slug, mod.key, selected));
  };
  return (
    <details className="card optional-mods">
      <summary>
        <span className="summary-title">Optional mods</span>
        <span className="muted small">
          {optional.filter((m) => m.selected).length} of {optional.length} included. The author marked these as extras.
        </span>
      </summary>
      <ul className="toggle-list">
        {optional.map((mod) => (
          <li key={mod.key}>
            <label className="toggle">
              <input
                type="checkbox"
                checked={mod.selected}
                disabled={mod.status === 'installed' || mod.status === 'downloading' || mod.status === 'installing'}
                onChange={(e) => toggle(mod, e.target.checked)}
              />
              <span className="toggle-name">{mod.name}</span>
              <span className="muted small">
                v{mod.version} · {formatBytes(mod.fileSize)}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </details>
  );
}
