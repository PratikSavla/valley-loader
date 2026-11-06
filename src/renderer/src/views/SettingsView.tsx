// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import type { AppSnapshot } from '@shared/types';
import { useActions } from '../hooks/useActions';
import { ApiKeyForm } from '../components/ApiKeyForm';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Icon } from '../components/Icon';
import { AboutSection } from '../components/AboutSection';

interface SettingsViewProps {
  snapshot: AppSnapshot;
  onRunSetup: () => void;
}

function AccountSection({ snapshot }: { snapshot: AppSnapshot }) {
  const { run, notify } = useActions();
  const [changing, setChanging] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const { user, rateLimit } = snapshot;

  const signOut = async (): Promise<void> => {
    setConfirmSignOut(false);
    const r = await run("Couldn't sign out", (api) => api.clearApiKey());
    if (r.ok) notify('Signed out. Your API key was removed from this Mac.', 'success');
  };

  return (
    <section className="card settings-section" aria-labelledby="account-title">
      <h2 id="account-title">Nexus account</h2>
      {user ? (
        <>
          <dl className="facts">
            <dt>Signed in as</dt>
            <dd>{user.name}</dd>
            <dt>Membership</dt>
            <dd>{user.isPremium ? 'Premium: downloads run automatically' : 'Free: one “Slow download” click per mod'}</dd>
            {rateLimit && (
              <>
                <dt>API requests left</dt>
                <dd>
                  {rateLimit.daily ?? '?'} today · {rateLimit.hourly ?? '?'} this hour
                </dd>
              </>
            )}
          </dl>
          <div className="btn-row">
            <button type="button" className="btn btn-secondary" aria-expanded={changing} onClick={() => setChanging((v) => !v)}>
              Change key
            </button>
            <button type="button" className="btn btn-quiet btn-danger-text" onClick={() => setConfirmSignOut(true)}>
              Sign out
            </button>
          </div>
          {changing && <ApiKeyForm submitLabel="Save new key" onSaved={() => setChanging(false)} />}
        </>
      ) : (
        <>
          {snapshot.hasApiKey && snapshot.apiKeyError ? (
            <p className="field-error" role="alert">
              Nexus Mods rejected your saved key ({snapshot.apiKeyError}). Enter a new one below.
            </p>
          ) : (
            <p className="muted">{snapshot.hasApiKey ? 'Checking your saved key…' : 'Add your personal API key so Valley Loader can talk to Nexus.'}</p>
          )}
          <ApiKeyForm />
        </>
      )}
      <ConfirmDialog open={confirmSignOut} title="Sign out of Nexus?" confirmLabel="Sign out" danger onConfirm={() => void signOut()} onCancel={() => setConfirmSignOut(false)}>
        <p>Your API key is removed from this Mac. Installed collections stay where they are.</p>
      </ConfirmDialog>
    </section>
  );
}

function GameSection({ snapshot }: { snapshot: AppSnapshot }) {
  const { run, notify } = useActions();
  const { game } = snapshot;
  const change = async (): Promise<void> => {
    // A wrong folder throws (toasted by run); undefined means the picker was cancelled, which needs no message.
    const r = await run("Couldn't change the game folder", (api) => api.pickGameFolder());
    if (r.ok && r.value) notify('Game folder updated.', 'success');
  };
  return (
    <section className="card settings-section" aria-labelledby="game-title">
      <h2 id="game-title">Stardew Valley</h2>
      <dl className="facts">
        <dt>Game folder</dt>
        <dd className="path">{game?.gamePath ?? snapshot.settings.gamePath ?? 'Not found yet'}</dd>
        <dt>Game version</dt>
        <dd>{game?.gameVersion ?? 'Unknown'}</dd>
        <dt>SMAPI</dt>
        <dd>{game ? (game.smapiInstalled ? (game.smapiVersion ?? 'Installed') : 'Not installed') : 'Unknown'}</dd>
      </dl>
      <button type="button" className="btn btn-secondary" onClick={() => void change()}>
        <Icon name="folder" size={14} /> Change…
      </button>
    </section>
  );
}

function LinksSection() {
  const { run, notify } = useActions();
  const register = async (): Promise<void> => {
    const r = await run("Couldn't register for Nexus links", (api) => api.registerNxmHandler());
    if (r.ok) notify(r.value ? 'Valley Loader now handles Nexus download links.' : 'macOS did not accept the change. Try again, or keep using the built-in Nexus window.', r.value ? 'success' : 'error');
  };
  return (
    <section className="card settings-section" aria-labelledby="links-title">
      <h2 id="links-title">Download links from your browser</h2>
      <p className="muted">
        Optional. Lets “Slow download” clicks in Safari or Chrome reach Valley Loader too, if the built-in Nexus window ever
        gives you trouble.
      </p>
      <button type="button" className="btn btn-secondary" onClick={() => void register()}>
        Handle Nexus download links
      </button>
    </section>
  );
}

export function SettingsView({ snapshot, onRunSetup }: SettingsViewProps) {
  return (
    <div className="view settings-view">
      <h1>Settings</h1>
      <div className="settings-grid">
        <AccountSection snapshot={snapshot} />
        <GameSection snapshot={snapshot} />
        <LinksSection />
        <section className="card settings-section" aria-labelledby="help-title">
          <h2 id="help-title">Setup help</h2>
          <p className="muted">Walk through the setup checks again: game, SMAPI, disk space, Nexus sign-in and more.</p>
          <button type="button" className="btn btn-primary" onClick={onRunSetup}>
            <Icon name="refresh" size={14} /> Run setup check
          </button>
        </section>
        <AboutSection />
      </div>
    </div>
  );
}
