// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState } from 'react';
import type { PlannedMod } from '@shared/types';
import { filterMods, sortedMods, type ModFilter } from '../lib/profile';
import { ModRow } from './ModRow';

const FILTERS: { value: ModFilter; label: string }[] = [
  { value: 'all', label: 'All mods' },
  { value: 'remaining', label: 'Not installed yet' },
  { value: 'attention', label: 'Needs attention' },
];

/** The collection's mods in deploy order (later rows win file conflicts). */
export function ModTable({ slug, mods }: { slug: string; mods: readonly PlannedMod[] }) {
  const [filter, setFilter] = useState<ModFilter>('all');
  const filterId = useId();
  const ordered = sortedMods(mods);
  const positions = new Map(ordered.map((m, i) => [m.key, i + 1]));
  const shown = filterMods(ordered, filter);
  return (
    <section className="card mod-table-card" aria-labelledby={`${filterId}-title`}>
      <div className="mod-table-head">
        <h2 id={`${filterId}-title`}>Mods in install order</h2>
        <label className="filter">
          <span>Show</span>
          <select id={filterId} value={filter} onChange={(e) => setFilter(e.target.value as ModFilter)}>
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="table-scroll">
        <table className="mod-table">
          <thead>
            <tr>
              <th scope="col" className="col-num">
                #
              </th>
              <th scope="col">Mod</th>
              <th scope="col">Source</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((mod) => (
              <ModRow key={mod.key} slug={slug} mod={mod} position={positions.get(mod.key) ?? 0} />
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <p className="empty-row">Nothing here. Nice!</p>}
      </div>
    </section>
  );
}
