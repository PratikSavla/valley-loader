// SPDX-License-Identifier: AGPL-3.0-only
// New-user guidance logic: input checks, setup gaps, onboarding gating, hint ids.
import { PREREQ_BUTTON_LABELS } from '@shared/prereqLabels';
import type { AppSnapshot, PrereqCheck } from '@shared/types';

/** Ids passed to <Hint id>; persisted in settings.dismissedHints once dismissed. */
export const HINT_IDS = {
  homePaste: 'home-paste',
  collectionFirstRun: 'collection-first-run',
  clickWhy: 'click-why',
  revisions: 'collection-revisions',
} as const;

export const EXAMPLE_COLLECTION_URL = 'https://www.nexusmods.com/games/stardewvalley/collections/tckf0m';

export type InputCheck = { ok: true; value: string } | { ok: false; error: string };

/**
 * Friendly first-pass check of what the user pasted. The main process does the real parsing;
 * this only catches the common mistakes (empty, a single mod page, another game) with a helpful message.
 */
export function checkCollectionInput(raw: string): InputCheck {
  const value = raw.trim();
  if (value === '') return { ok: false, error: 'Paste a collection link first.' };
  const lower = value.toLowerCase();
  if (lower.startsWith('nxm://')) return { ok: true, value };
  if (/^[a-z0-9]{4,12}$/i.test(value)) return { ok: true, value };
  if (lower.includes('nexusmods.com')) {
    if (!lower.includes('stardewvalley')) {
      return { ok: false, error: 'Valley Loader only installs Stardew Valley collections.' };
    }
    if (lower.includes('/collections/')) return { ok: true, value };
    if (/\/mods\/\d+/.test(lower)) {
      return {
        ok: false,
        error: 'That link is a single mod page. Collection links contain "/collections/" followed by a short code.',
      };
    }
  }
  return { ok: false, error: `That doesn't look like a collection link. It should look like ${EXAMPLE_COLLECTION_URL}` };
}

export interface SetupGap {
  id: 'apiKey' | 'game' | 'smapi';
  text: string;
}

/** Cheap, snapshot-only view of what a new user still has to set up (shown as an app-level banner). */
export function setupGaps(snapshot: Pick<AppSnapshot, 'hasApiKey' | 'game' | 'apiKeyError'>): SetupGap[] {
  const gaps: SetupGap[] = [];
  if (!snapshot.hasApiKey) gaps.push({ id: 'apiKey', text: 'Add your Nexus API key' });
  else if (snapshot.apiKeyError) gaps.push({ id: 'apiKey', text: 'Nexus Mods rejected your saved API key — enter a new one' });
  if (!snapshot.game) gaps.push({ id: 'game', text: 'Choose your Stardew Valley folder' });
  else if (!snapshot.game.smapiInstalled) gaps.push({ id: 'smapi', text: 'Install SMAPI (the mod loader)' });
  return gaps;
}

export interface OnboardingGate {
  canContinue: boolean;
  fails: number;
  warns: number;
  pending: number;
}

/** Continue is allowed once checks have loaded, none are still running, and none fail. Warnings are fine. */
export function onboardingGate(checks: readonly PrereqCheck[] | undefined): OnboardingGate {
  const list = checks ?? [];
  const count = (s: PrereqCheck['status']): number => list.filter((c) => c.status === s).length;
  const fails = count('fail');
  const pending = count('pending');
  return { canContinue: list.length > 0 && fails === 0 && pending === 0, fails, warns: count('warn'), pending };
}

/** The button text for a check's action: the same words the check's fix steps tell the user to press. */
export function prereqActionLabel(action: NonNullable<PrereqCheck['action']>): string {
  return PREREQ_BUTTON_LABELS[action];
}

/** Line under the wizard's Continue button while it is disabled. */
export function wizardNote(gate: OnboardingGate): string {
  if (gate.fails > 0) return 'Continue unlocks when nothing is marked “Needs fixing”.';
  if (gate.pending > 0) return 'Still checking… press Re-check if this doesn’t finish.';
  return 'Continue unlocks once the checks have run.';
}
