// SPDX-License-Identifier: AGPL-3.0-only
import type { NexusUser } from '@shared/types';
import { Icon } from './Icon';

export type NavTarget = 'home' | 'settings';

interface TopBarProps {
  current: NavTarget | 'collection' | 'setup';
  user: NexusUser | undefined;
  hasApiKey: boolean;
  /** Nexus refused the saved key (snapshot.apiKeyError). */
  keyRejected: boolean;
  onNavigate: (target: NavTarget) => void;
}

export function TopBar({ current, user, hasApiKey, keyRejected, onNavigate }: TopBarProps) {
  const navItem = (target: NavTarget, label: string, icon: 'home' | 'gear') => (
    <button
      type="button"
      className="nav-btn"
      aria-current={current === target ? 'page' : undefined}
      onClick={() => onNavigate(target)}
    >
      <Icon name={icon} size={16} />
      {label}
    </button>
  );

  return (
    <header className="topbar">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="brand">
        <span className="brand-mark">
          <Icon name="leaf" size={20} />
        </span>
        <span className="brand-name">Valley Loader</span>
      </div>
      <nav className="nav" aria-label="Main">
        {navItem('home', 'Collections', 'home')}
        {navItem('settings', 'Settings', 'gear')}
      </nav>
      <div className="account-pill" aria-label="Nexus account">
        {user ? (
          <>
            <span className="account-name">{user.name}</span>
            <span className={user.isPremium ? 'tier tier-premium' : 'tier'}>{user.isPremium ? 'Premium' : 'Free'}</span>
          </>
        ) : (
          <span className="muted">{!hasApiKey ? 'Not signed in' : keyRejected ? 'Key rejected' : 'Checking account…'}</span>
        )}
      </div>
    </header>
  );
}
