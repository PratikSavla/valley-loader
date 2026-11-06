// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { SMAPI_URL } from '@shared/smapi';
import type { GameInfo, ProfileState, ProfileUpdate, RevisionDiff } from '@shared/types';
import { HINT_IDS } from '../lib/guidance';
import { plural } from '../lib/format';
import { startLabel } from '../lib/profile';
import {
  applyBlockedReason,
  availableUpdate,
  changedLabel,
  clicksText,
  diffSummary,
  newModsToFetch,
  relativeTime,
  smapiUpgradeNeeded,
  type UpdateAccount,
} from '../lib/updates';
import { useActions } from '../hooks/useActions';
import { useAppliedUpdate } from '../hooks/useAppliedUpdate';
import { ExternalLink } from './ExternalLink';
import { Hint } from './Hint';
import { Icon } from './Icon';

interface UpdatePanelProps {
  profile: ProfileState;
  game: GameInfo | undefined;
  premium: boolean;
  account: UpdateAccount;
  dismissedHints: readonly string[];
}

/** Current time, refreshed every minute so "Last checked …" stays honest. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function RevisionsHint({ dismissedHints }: { dismissedHints: readonly string[] }) {
  return (
    <Hint id={HINT_IDS.revisions} title="Why updates come as revisions" dismissedHints={dismissedHints}>
      <p>A collection pins the exact file of every mod, the set its curator tested together.</p>
      <p>Curators ship updates as new revisions of the collection, and Valley Loader checks for them every few hours.</p>
      <p>
        Single mods are never updated to a newer Nexus version on their own: that would skip the curator&apos;s testing and could
        break the patches and settings made for the pinned files.
      </p>
    </Hint>
  );
}

function DiffLists({ diff }: { diff: RevisionDiff }) {
  // Mod names come from Nexus and are rendered as plain text only.
  return (
    <div className="update-lists">
      {diff.added.length > 0 && (
        <details>
          <summary>Added ({diff.added.length})</summary>
          <ul>
            {diff.added.map((m) => (
              <li key={`${m.modId}:${m.fileId}`}>
                {m.name} <span className="muted">v{m.version}{m.optional ? ' · optional' : ''}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {diff.changed.length > 0 && (
        <details>
          <summary>Changed ({diff.changed.length})</summary>
          <ul>
            {diff.changed.map((m, i) => (
              <li key={`${m.modId}:${i}`}>
                {m.name} <span className="muted">{changedLabel(m)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {diff.removed.length > 0 && (
        <details>
          <summary>Removed ({diff.removed.length})</summary>
          <ul>
            {diff.removed.map((m, i) => (
              <li key={`${m.name}:${i}`}>
                {m.name} <span className="muted">v{m.version}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {diff.unavailable !== undefined && diff.unavailable > 0 && (
        <p className="muted small">
          {plural(diff.unavailable, 'pinned file')} {diff.unavailable === 1 ? 'is' : 'are'} no longer on Nexus Mods; Valley Loader
          can&apos;t download {diff.unavailable === 1 ? 'it' : 'them'}.
        </p>
      )}
      <p className="muted small">Mods bundled inside the collection aren&apos;t listed; they are refreshed with the update.</p>
    </div>
  );
}

interface BannerProps {
  profile: ProfileState;
  update: ProfileUpdate;
  game: GameInfo | undefined;
  premium: boolean;
  account: UpdateAccount;
  checking: boolean;
  applying: boolean;
  onApply: () => void;
  onCheck: () => void;
}

function UpdateBanner({ profile, update, game, premium, account, checking, applying, onApply, onCheck }: BannerProps) {
  const titleId = useId();
  const reasonId = useId();
  const now = useNow();
  const blocked = applyBlockedReason(profile, account);
  const diff = update.diff;
  const smapi = diff ? smapiUpgradeNeeded(diff, game) : undefined;
  return (
    <section className="update-banner" aria-labelledby={titleId}>
      <Icon name="refresh" size={22} />
      <div className="update-body">
        <h2 id={titleId}>
          Revision {update.latestRevision} is available (you have {profile.revision})
        </h2>
        {diff ? (
          <p>
            {diffSummary(diff)}. Updating needs {clicksText(diff, premium)}.
          </p>
        ) : (
          <p>The list of changes couldn&apos;t be loaded. Press Check again to retry.</p>
        )}
        {smapi && (
          <p className="update-warn" role="note">
            <Icon name="alert" size={16} /> This revision needs SMAPI {smapi} or newer
            {game?.smapiVersion ? `; you have ${game.smapiVersion}` : ''}. Update SMAPI before playing:{' '}
            <ExternalLink href={SMAPI_URL}>Get SMAPI from smapi.io</ExternalLink>
          </p>
        )}
        {diff && <DiffLists diff={diff} />}
        <div role="status">
          {update.error && (
            <p className="muted small">
              Last check ({relativeTime(update.checkedAt, now)}) didn&apos;t work: {update.error}
            </p>
          )}
        </div>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={onApply}
            disabled={blocked !== undefined || applying}
            aria-busy={applying}
            aria-describedby={blocked ? reasonId : undefined}
          >
            {applying ? `Updating to revision ${update.latestRevision}…` : `Update to revision ${update.latestRevision}`}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onCheck} disabled={checking || applying} aria-busy={checking}>
            {checking ? 'Checking…' : 'Check again'}
          </button>
        </div>
        {blocked && !applying && (
          <p id={reasonId} className="muted small">
            {blocked}
          </p>
        )}
      </div>
    </section>
  );
}

function LastChecked({ update, checking, onCheck }: { update: ProfileUpdate | undefined; checking: boolean; onCheck: () => void }) {
  const now = useNow();
  let text = 'Not checked for a newer revision yet.';
  if (update?.error) text = `Checked ${relativeTime(update.checkedAt, now)}, but it didn't work: ${update.error}`;
  else if (update) text = `Up to date. Last checked ${relativeTime(update.checkedAt, now)}.`;
  return (
    <p className="last-checked muted small">
      <span role="status">{text}</span>{' '}
      <button type="button" className="btn btn-quiet btn-small" onClick={onCheck} disabled={checking} aria-busy={checking}>
        {checking ? 'Checking…' : 'Check for updates'}
      </button>
    </p>
  );
}

/**
 * Announces the result of a manual check once the refreshed profile has arrived. checkForUpdates never rejects
 * (failures land in update.error), so the result is read from the store push, not from the IPC call.
 */
function useCheckResult(profile: ProfileState): (checkedAtBefore: string) => void {
  const { notify } = useActions();
  const waitingFor = useRef<string | undefined>(undefined); // checkedAt from before the click
  const latest = useRef(profile);
  const report = useCallback(
    (u: ProfileUpdate, revision: number) => {
      if (u.error) notify(`Couldn't check for a newer revision: ${u.error}`, 'error');
      else if (u.latestRevision > revision) notify(`Revision ${u.latestRevision} is available`, 'info');
      else notify('Still up to date', 'info');
    },
    [notify],
  );
  useEffect(() => {
    latest.current = profile;
    const u = profile.update;
    if (waitingFor.current === undefined || u === undefined || u.checkedAt === waitingFor.current) return;
    waitingFor.current = undefined;
    report(u, profile.revision);
  }, [profile, report]);
  return useCallback(
    (before: string) => {
      const { update, revision } = latest.current;
      if (update !== undefined && update.checkedAt !== before) report(update, revision);
      else waitingFor.current = before;
    },
    [report],
  );
}

/** "New revision available" banner, the post-update next step, or a quiet "last checked" line. */
export function UpdatePanel({ profile, game, premium, account, dismissedHints }: UpdatePanelProps) {
  const { run, notify } = useActions();
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useAppliedUpdate(profile.slug);
  const announceCheck = useCheckResult(profile);
  const update = availableUpdate(profile);
  const { slug } = profile;

  const check = async (): Promise<void> => {
    setChecking(true);
    const before = profile.update?.checkedAt ?? '';
    const r = await run("Couldn't check for a newer revision", (api) => api.checkForUpdates(slug));
    setChecking(false);
    if (r.ok) announceCheck(before);
  };
  const apply = async (): Promise<void> => {
    if (applying) return;
    setApplying(true);
    try {
      const keysBefore = new Set(profile.mods.map((m) => m.key));
      const result = await run("Couldn't update the collection", (api) => api.applyUpdate(slug));
      if (!result.ok) return;
      setApplied({ revision: result.value.revision, keysBefore });
      notify(`Updated to revision ${result.value.revision}`, 'success');
    } finally {
      setApplying(false);
    }
  };

  const pending = applied && applied.revision === profile.revision ? newModsToFetch(profile, applied.keysBefore) : 0;
  return (
    <>
      {update && (
        <UpdateBanner
          {...{ profile, update, game, premium, account, checking, applying }}
          onApply={() => void apply()}
          onCheck={() => void check()}
        />
      )}
      {pending > 0 && !profile.running && (
        <p className="callout callout-ok" role="status">
          <Icon name="check" size={18} /> Updated to revision {profile.revision}. Press &ldquo;{startLabel(profile)}&rdquo; to download the{' '}
          {plural(pending, 'new or changed mod')}.
        </p>
      )}
      {!update && <LastChecked update={profile.update} checking={checking} onCheck={() => void check()} />}
      {update && <RevisionsHint dismissedHints={dismissedHints} />}
    </>
  );
}
