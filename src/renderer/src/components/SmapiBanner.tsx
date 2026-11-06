// SPDX-License-Identifier: AGPL-3.0-only
import type { GameInfo } from '@shared/types';
import { SMAPI_INSTALL_STEPS, SMAPI_URL } from '@shared/smapi';
import { smapiState } from '../lib/version';
import { ExternalLink } from './ExternalLink';
import { Icon } from './Icon';

/** Warns when SMAPI is missing or older than the collection needs, with the macOS install steps. Renders nothing when fine. */
export function SmapiBanner({ game, requirement }: { game: GameInfo | undefined; requirement: string | undefined }) {
  const state = smapiState(game, requirement);
  if (state.kind === 'ok' || state.kind === 'unknown') return null;
  return (
    <section className="banner banner-warn" role="note" aria-label="SMAPI requirement">
      <Icon name="alert" size={20} />
      <div>
        {state.kind === 'missing' ? (
          <p>
            <strong>SMAPI isn&apos;t installed.</strong> Mods need SMAPI to load
            {state.required ? ` (this collection asks for ${state.required} or newer)` : ''}. On a Mac it is installed by
            hand:
          </p>
        ) : (
          <p>
            <strong>
              This collection needs SMAPI {state.required} or newer; you have {state.installed}.
            </strong>{' '}
            Play stays blocked until SMAPI is updated. Installing over the old version is safe and keeps your mods:
          </p>
        )}
        <ol className="fix-steps">
          {SMAPI_INSTALL_STEPS.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
        <p>Then press Play: Valley Loader re-checks SMAPI automatically.</p>
        <p>
          <ExternalLink href={SMAPI_URL}>Get SMAPI from smapi.io</ExternalLink>
        </p>
      </div>
    </section>
  );
}
