// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useMemo, useState } from 'react';
import type { AppSnapshot } from '@shared/types';
import { ActionsContext, createActions } from './hooks/useActions';
import { useSnapshot } from './hooks/useSnapshot';
import { useToasts } from './hooks/useToasts';
import { PendingCollectionDialog } from './components/PendingCollectionDialog';
import { Toasts } from './components/Toasts';
import { TopBar, type NavTarget } from './components/TopBar';
import { CollectionView } from './views/CollectionView';
import { Home } from './views/Home';
import { Onboarding } from './views/Onboarding';
import { SettingsView } from './views/SettingsView';

type View = { name: 'home' } | { name: 'collection'; slug: string } | { name: 'settings' } | { name: 'setup' };

function Splash({ message, error }: { message: string; error?: boolean }) {
  return (
    <div className="splash" role={error ? 'alert' : 'status'}>
      <p className={error ? 'field-error' : 'muted'}>{message}</p>
      {error && <p className="muted small">Quit and reopen Valley Loader. If it keeps happening, reinstall the app.</p>}
    </div>
  );
}

function MainContent({ snapshot, view, go }: { snapshot: AppSnapshot; view: View; go: (v: View) => void }) {
  const profile = view.name === 'collection' ? snapshot.profiles.find((p) => p.slug === view.slug) : undefined;
  if (view.name === 'settings') return <SettingsView snapshot={snapshot} onRunSetup={() => go({ name: 'setup' })} />;
  if (profile) return <CollectionView snapshot={snapshot} profile={profile} onBack={() => go({ name: 'home' })} />;
  return (
    <Home
      snapshot={snapshot}
      onOpenProfile={(slug) => go({ name: 'collection', slug })}
      onRunSetup={() => go({ name: 'setup' })}
    />
  );
}

export function App() {
  const { toasts, push, dismiss } = useToasts();
  const onLastError = useCallback((message: string) => push(message, 'error'), [push]);
  const { snapshot, loadError } = useSnapshot(onLastError);
  const actions = useMemo(() => createActions(push), [push]);
  const [view, setView] = useState<View>({ name: 'home' });

  let body;
  if (loadError) body = <Splash message={loadError} error />;
  else if (!snapshot) body = <Splash message="Opening Valley Loader…" />;
  else if (!snapshot.settings.onboardingComplete || view.name === 'setup') {
    const rerun = snapshot.settings.onboardingComplete;
    body = (
      <main id="main">
        <Onboarding
          rerun={rerun}
          account={{ hasApiKey: snapshot.hasApiKey, userId: snapshot.user?.userId, apiKeyError: snapshot.apiKeyError }}
          onFinish={() => setView({ name: 'home' })}
          onClose={() => setView({ name: 'settings' })}
        />
      </main>
    );
  } else {
    body = (
      <>
        <TopBar
          current={view.name}
          user={snapshot.user}
          hasApiKey={snapshot.hasApiKey}
          keyRejected={snapshot.apiKeyError !== undefined}
          onNavigate={(target: NavTarget) => setView(target === 'home' ? { name: 'home' } : { name: 'settings' })}
        />
        <main id="main" tabIndex={-1}>
          <MainContent snapshot={snapshot} view={view} go={setView} />
        </main>
        <PendingCollectionDialog
          pending={snapshot.pendingCollection}
          profiles={snapshot.profiles}
          onResolved={(slug) => setView({ name: 'collection', slug })}
        />
      </>
    );
  }

  return (
    <ActionsContext.Provider value={actions}>
      <div className="app">{body}</div>
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </ActionsContext.Provider>
  );
}
