// SPDX-License-Identifier: AGPL-3.0-only
import { HINT_IDS } from '../lib/guidance';
import { useActions } from '../hooks/useActions';
import { Hint } from './Hint';
import { Icon } from './Icon';

interface ClickBannerProps {
  /** As given in snapshot.awaitingClick (displayed as-is; expected 1-based). */
  index: number;
  total: number;
  modName: string | undefined;
  dismissedHints: readonly string[];
}

/** The one thing a free user must do: click Slow download in the Nexus window. */
export function ClickBanner({ index, total, modName, dismissedHints }: ClickBannerProps) {
  const { run } = useActions();
  return (
    <section className="click-banner" aria-labelledby="click-banner-title">
      <div className="click-banner-main">
        <span className="click-icon">
          <Icon name="cursor" size={26} />
        </span>
        <div aria-live="polite" aria-atomic="true">
          <p className="click-count">
            Mod {index} of {total}
            {modName ? ` · ${modName}` : ''}
          </p>
          <h2 id="click-banner-title">
            In the Nexus window, click <strong>Slow download</strong>
          </h2>
          <p className="click-why">
            Free Nexus accounts need one click per mod. Valley Loader catches the download and opens the next mod for you.
          </p>
        </div>
        <button type="button" className="btn btn-primary btn-large" onClick={() => void run("Couldn't show the Nexus window", (api) => api.focusNexusWindow())}>
          Show Nexus window
        </button>
      </div>
      <Hint id={HINT_IDS.clickWhy} title="Why do I have to click?" dismissedHints={dismissedHints}>
        <p>
          Nexus only hands out download links to free accounts through the website&apos;s Slow download button. Automating
          that click would break Nexus&apos;s rules and could get your account banned, so Valley Loader leaves it to you.
          Nexus Premium accounts skip this step entirely.
        </p>
        <p>
          Signed out in the Nexus window? Sign in there once; it remembers you. If the page asks you to pick a download
          manager, choose Slow download.
        </p>
      </Hint>
    </section>
  );
}
