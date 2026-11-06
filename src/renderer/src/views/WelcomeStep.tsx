// SPDX-License-Identifier: AGPL-3.0-only
import { Icon } from '../components/Icon';

export function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <>
      <p className="lead">Install Nexus Mods collections for Stardew Valley on your Mac, the way Vortex does on Windows.</p>
      <ul className="feature-list">
        <li>
          <Icon name="leaf" size={20} />
          <span>
            <strong>Paste a collection link</strong>, and Valley Loader reads its full mod list, versions and install order.
          </span>
        </li>
        <li>
          <Icon name="refresh" size={20} />
          <span>
            <strong>It downloads and installs every mod for you</strong>, checking each file and resuming if you quit halfway.
          </span>
        </li>
        <li>
          <Icon name="play" size={20} />
          <span>
            <strong>Press Play</strong> to start the game through SMAPI with that collection loaded.
          </span>
        </li>
      </ul>
      <div className="callout callout-ok">
        <Icon name="check" size={20} />
        <p>
          Your existing Mods folder is never touched. Each collection gets its own profile, so collections can&apos;t clash and
          removing one is clean.
        </p>
      </div>
      <div className="callout">
        <Icon name="cursor" size={20} />
        <p>
          <strong>Free Nexus account?</strong> Nexus asks free members to click <strong>Slow download</strong> once for every
          mod. Valley Loader opens each page for you and does the rest, but it will never click for you, because that breaks
          Nexus&apos;s rules. Premium members skip the clicking.
        </p>
      </div>
      <div className="wizard-actions">
        <button type="button" className="btn btn-primary btn-large" onClick={onNext}>
          Check my setup
        </button>
      </div>
    </>
  );
}
