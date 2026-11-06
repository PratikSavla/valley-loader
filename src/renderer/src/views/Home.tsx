// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState, type FormEvent } from 'react';
import type { AppSnapshot, ProfileState } from '@shared/types';
import { EXAMPLE_COLLECTION_URL, HINT_IDS, checkCollectionInput, setupGaps } from '../lib/guidance';
import { useActions } from '../hooks/useActions';
import { Hint } from '../components/Hint';
import { ProfileCard } from '../components/ProfileCard';
import { SetupBanner } from '../components/SetupBanner';

interface HomeProps {
  snapshot: AppSnapshot;
  onOpenProfile: (slug: string) => void;
  onRunSetup: () => void;
}

function PasteForm({ onResolved }: { onResolved: (profile: ProfileState) => void }) {
  const { run } = useActions();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const inputId = useId();
  const errorId = useId();

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const check = checkCollectionInput(value);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setError(undefined);
    setLoading(true);
    const result = await run("Couldn't load that collection", (api) => api.resolveCollection(check.value), { toast: false });
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setValue('');
    onResolved(result.value);
  };

  return (
    <form className="paste-form" onSubmit={(e) => void submit(e)} noValidate aria-busy={loading}>
      <label htmlFor={inputId} className="paste-label">
        Paste a Nexus collection link
      </label>
      <div className="paste-row">
        <input
          id={inputId}
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={EXAMPLE_COLLECTION_URL}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          disabled={loading}
        />
        <button type="submit" className="btn btn-primary btn-large" disabled={loading}>
          {loading ? 'Loading…' : 'Install'}
        </button>
      </div>
      <div aria-live="polite">
        {loading && <p className="muted small">Fetching the collection&apos;s mod list from Nexus. This takes a few seconds.</p>}
      </div>
      {error && (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

export function Home({ snapshot, onOpenProfile, onRunSetup }: HomeProps) {
  const { run } = useActions();
  const gaps = setupGaps(snapshot);
  const open = (profile: ProfileState): void => {
    void run("Couldn't select that collection", (api) => api.setActiveProfile(profile.slug));
    onOpenProfile(profile.slug);
  };
  const play = (profile: ProfileState): void => {
    void run(`Couldn't start Stardew Valley`, (api) => api.launchGame(profile.slug));
  };
  return (
    <div className="view home-view">
      <SetupBanner gaps={gaps} onRunSetup={onRunSetup} />
      <section className="hero card">
        <h1>Install a whole collection in one go</h1>
        <p className="muted">Valley Loader sets up every mod in its own folder, so your regular game stays exactly as it is.</p>
        <PasteForm onResolved={open} />
      </section>
      <Hint id={HINT_IDS.homePaste} title="Where do I find a collection link?" dismissedHints={snapshot.settings.dismissedHints}>
        <p>
          On nexusmods.com, open <strong>Stardew Valley → Collections</strong> and choose one. Copy the address from your
          browser&apos;s address bar; it ends in <code>/collections/</code> and a short code such as <code>tckf0m</code>. Pasting
          just the code works too.
        </p>
      </Hint>
      <section aria-labelledby="profiles-title" className="profiles">
        <h2 id="profiles-title">Your collections</h2>
        {snapshot.profiles.length === 0 ? (
          <p className="empty-state">No collections yet. Paste a link above to add your first one.</p>
        ) : (
          <ul className="profile-list">
            {snapshot.profiles.map((profile) => (
              <ProfileCard key={profile.slug} profile={profile} onOpen={() => open(profile)} onPlay={() => play(profile)} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
