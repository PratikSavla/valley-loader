// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import type { PendingCollection, ProfileState } from '@shared/types';
import { useActions } from '../hooks/useActions';
import { ConfirmDialog } from './ConfirmDialog';

interface PendingCollectionDialogProps {
  pending: PendingCollection | undefined;
  profiles: readonly ProfileState[];
  onResolved: (slug: string) => void;
}

/** What confirming the link would do to the user's profiles, in words. */
function describe(pending: PendingCollection, existing: ProfileState | undefined): { text: string; older: boolean } {
  const rev = pending.revision === undefined ? 'the latest revision' : `revision ${pending.revision}`;
  if (existing === undefined) return { text: `This adds the collection "${pending.slug}" (${rev}) to Valley Loader.`, older: false };
  if (pending.revision === existing.revision) return { text: `"${existing.name}" is already on revision ${existing.revision}; its mod list is re-checked.`, older: false };
  const older = pending.revision !== undefined && pending.revision < existing.revision;
  const change = `This changes "${existing.name}" from revision ${existing.revision} to ${rev}. Installed mods that ${rev} doesn't include are removed from this collection.`;
  return { text: older ? `${change} ${rev[0]?.toUpperCase() ?? ''}${rev.slice(1)} is OLDER than the one you have.` : change, older };
}

/**
 * A collection link that arrived from outside the app (a website or another program opened an nxm:// link) is only a
 * proposal: nothing is downloaded or changed until the user confirms here.
 */
export function PendingCollectionDialog({ pending, profiles, onResolved }: PendingCollectionDialogProps) {
  const { run } = useActions();
  const [busy, setBusy] = useState(false);
  if (pending === undefined) return null;
  const existing = profiles.find((p) => p.slug.toLowerCase() === pending.slug.toLowerCase());
  const { text, older } = describe(pending, existing);
  const confirm = async (): Promise<void> => {
    setBusy(true);
    const r = await run("Couldn't load that collection", (api) => api.resolveCollection(pending.url, older ? { allowDowngrade: true } : {}));
    setBusy(false);
    if (r.ok) onResolved(r.value.slug);
  };
  const cancel = (): void => {
    void run("Couldn't dismiss the collection link", (api) => api.dismissPendingCollection());
  };
  return (
    <ConfirmDialog
      open={!busy}
      title={existing ? `Change "${existing.name}"?` : 'Add this collection?'}
      confirmLabel={older ? 'Go back to the older revision' : existing ? 'Change collection' : 'Add collection'}
      danger={older}
      onConfirm={() => void confirm()}
      onCancel={cancel}
    >
      <p>A collection link was opened in Valley Loader from your browser or another app.</p>
      <p>{text}</p>
      <p className="muted small">If you didn&apos;t click a collection link just now, press Cancel.</p>
    </ConfirmDialog>
  );
}
