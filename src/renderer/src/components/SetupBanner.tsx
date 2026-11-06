// SPDX-License-Identifier: AGPL-3.0-only
import type { SetupGap } from '../lib/guidance';
import { Icon } from './Icon';

/** App-level nudge shown on main screens while basic setup is still missing. */
export function SetupBanner({ gaps, onRunSetup }: { gaps: readonly SetupGap[]; onRunSetup: () => void }) {
  if (gaps.length === 0) return null;
  return (
    <section className="setup-banner" aria-labelledby="setup-banner-title">
      <Icon name="alert" size={22} />
      <div>
        <h2 id="setup-banner-title">A little setup is still needed</h2>
        <ul>
          {gaps.map((gap) => (
            <li key={gap.id}>{gap.text}</li>
          ))}
        </ul>
      </div>
      <button type="button" className="btn btn-primary" onClick={onRunSetup}>
        Run setup check
      </button>
    </section>
  );
}
