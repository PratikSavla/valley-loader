// SPDX-License-Identifier: AGPL-3.0-only
import type { AppSnapshot, ProfileState } from '@shared/types';
import { HINT_IDS } from '../lib/guidance';
import { isUpdating, profileStats } from '../lib/profile';
import { ClickBanner } from '../components/ClickBanner';
import { CollectionHeader } from '../components/CollectionHeader';
import { Hint } from '../components/Hint';
import { ModTable } from '../components/ModTable';
import { OptionalMods } from '../components/OptionalMods';
import { SmapiBanner } from '../components/SmapiBanner';
import { SummaryBar } from '../components/SummaryBar';
import { UpdatePanel } from '../components/UpdateBanner';

interface CollectionViewProps {
  snapshot: AppSnapshot;
  profile: ProfileState;
  onBack: () => void;
}

function NextStepsHint({ premium, dismissedHints }: { premium: boolean; dismissedHints: readonly string[] }) {
  return (
    <Hint id={HINT_IDS.collectionFirstRun} title="What happens when you press Start" dismissedHints={dismissedHints}>
      <ol className="hint-steps">
        <li>Bundled mods (shipped inside the collection) install straight away.</li>
        {premium ? (
          <li>Your Premium account downloads every Nexus mod automatically, up to three at a time.</li>
        ) : (
          <li>
            A Nexus window opens on each mod&apos;s file page. Click <strong>Slow download</strong>; the app takes it from there and
            moves to the next mod.
          </li>
        )}
        <li>Each mod is checked and installed into this collection&apos;s own folder, never your regular Mods folder.</li>
        <li>You can pause or quit any time; Resume continues where you stopped.</li>
      </ol>
    </Hint>
  );
}

function InstallInstructions({ text }: { text: string }) {
  // Author-supplied and untrusted: rendered as plain text only.
  return (
    <details className="card instructions">
      <summary>
        <span className="summary-title">Notes from the collection author</span>
        <span className="muted small">Read before playing</span>
      </summary>
      <p className="plain-text">{text}</p>
    </details>
  );
}

export function CollectionView({ snapshot, profile, onBack }: CollectionViewProps) {
  const stats = profileStats(profile);
  const awaiting = snapshot.awaitingClick?.slug === profile.slug ? snapshot.awaitingClick : undefined;
  const awaitingMod = awaiting ? profile.mods.find((m) => m.key === awaiting.key) : undefined;
  const dismissed = snapshot.settings.dismissedHints;
  const fresh = stats.installed === 0 && !profile.running;
  const account = {
    hasApiKey: snapshot.hasApiKey,
    keyRejected: snapshot.apiKeyError !== undefined,
    updating: isUpdating(snapshot.resolving, profile.slug),
  };
  return (
    <div className="view collection-view">
      <CollectionHeader
        profile={profile}
        hasApiKey={account.hasApiKey}
        keyRejected={account.keyRejected}
        updating={account.updating}
        onBack={onBack}
        onRemoved={onBack}
      />
      {awaiting && (
        <ClickBanner index={awaiting.index} total={awaiting.total} modName={awaitingMod?.name} dismissedHints={dismissed} />
      )}
      <UpdatePanel
        profile={profile}
        game={snapshot.game}
        premium={snapshot.user?.isPremium ?? false}
        account={account}
        dismissedHints={dismissed}
      />
      <SmapiBanner game={snapshot.game} requirement={profile.smapiRequirement} />
      {fresh && <NextStepsHint premium={snapshot.user?.isPremium ?? false} dismissedHints={dismissed} />}
      <SummaryBar stats={stats} />
      {profile.installInstructions && <InstallInstructions text={profile.installInstructions} />}
      <OptionalMods slug={profile.slug} mods={profile.mods} />
      <ModTable slug={profile.slug} mods={profile.mods} />
    </div>
  );
}
