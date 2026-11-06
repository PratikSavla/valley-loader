// SPDX-License-Identifier: AGPL-3.0-only
// Onboarding / prerequisite checks. Pure: all environment access is injected.
// Copy is written for a brand-new, non-technical player. fixSteps are plain sentences without
// numbers; the renderer shows them as an ordered (numbered) list.
import { PREREQ_BUTTON_LABELS as L } from '@shared/prereqLabels';
import { SMAPI_INSTALL_STEPS as SMAPI_STEPS, SMAPI_URL } from '@shared/smapi';
import type { GameInfo, NexusUser, PrereqCheck } from '@shared/types';
import { compareVersions } from './game/detect';

export { PREREQ_BUTTON_LABELS } from '@shared/prereqLabels';
export { SMAPI_URL } from '@shared/smapi';

export interface PrereqInputs {
  platform: string; // process.platform
  arch: string; // process.arch
  macosVersion?: string;
  game?: GameInfo;
  /** Highest SMAPI version required by any profile, if known. */
  smapiRequired?: string;
  freeDiskBytes?: number;
  /** Bytes needed for the largest pending collection (0 when none). */
  neededDiskBytes: number;
  hasApiKey: boolean;
  user?: NexusUser;
  apiKeyError?: string;
  /** Validating the saved key failed for a reason other than a rejected key (offline, Nexus down). */
  apiKeyUnreachable?: string;
  /** undefined = unknown (window never opened). Only relevant for free accounts. */
  nexusLoggedIn?: boolean;
  nxmHandlerRegistered: boolean;
}

export const API_KEYS_URL = 'https://next.nexusmods.com/settings/api-keys';
export const NEXUS_URL = 'https://www.nexusmods.com';
/** Archive + staging copy + deployed copy ≈ 2.5× the collection's download size. */
export const DISK_FACTOR = 2.5;
/** Baseline space asked for when no collection is pending yet (a typical collection deploys in 1–2 GB). */
export const MIN_DISK_BYTES = 2e9;
/** Collections built for Stardew Valley 1.6 need at least this game version. */
export const MIN_GAME_VERSION = '1.6.0';

type Check = PrereqCheck;

function check(id: Check['id'], title: string, status: Check['status'], detail: string, extra: Partial<Check> = {}): Check {
  return { id, title, status, detail, fixSteps: [], ...extra };
}

/** Produce the 7 checks in fixed order: platform, game, smapi, disk, apiKey, nexusLogin, nxmHandler. */
export function evaluatePrereqs(inputs: PrereqInputs): PrereqCheck[] {
  return [
    platformCheck(inputs),
    gameCheck(inputs.game),
    smapiCheck(inputs.game, inputs.smapiRequired),
    diskCheck(inputs.freeDiskBytes, inputs.neededDiskBytes),
    apiKeyCheck(inputs),
    nexusLoginCheck(inputs.user, inputs.nexusLoggedIn),
    nxmHandlerCheck(inputs.nxmHandlerRegistered),
  ];
}

function archLabel(arch: string): string {
  if (arch === 'arm64') return 'Apple silicon (arm64)';
  if (arch === 'x64') return 'Intel (x64)';
  return arch;
}

function platformCheck({ platform, arch, macosVersion }: PrereqInputs): Check {
  const title = 'Mac computer';
  if (platform === 'darwin') {
    return check('platform', title, 'pass', `macOS ${macosVersion ?? '(version unknown)'} on ${archLabel(arch)}`);
  }
  return check('platform', title, 'fail', `Valley Loader only runs on macOS (this computer reports "${platform}").`, {
    fixSteps: [
      'Run Valley Loader on a Mac.',
      'On Windows, use Vortex from Nexus Mods instead: it installs collections natively.',
    ],
    fixUrl: `${NEXUS_URL}/about/vortex`,
  });
}

function gameCheck(game: GameInfo | undefined): Check {
  const title = 'Stardew Valley';
  if (!game) {
    return check('game', title, 'fail', "Couldn't find Stardew Valley on this Mac.", {
      fixSteps: [
        'Install Stardew Valley from Steam (or GOG) if you haven\'t already.',
        'Start the game once from Steam (or GOG) and get to the title screen, then quit. This finishes the install.',
        `Come back here and press "${L.recheck}". If it still isn't found, press "${L.pickGameFolder}" and pick the "Stardew Valley" folder or "Stardew Valley.app".`,
        'Steam players can find the folder in Steam: right-click Stardew Valley → Manage → Browse local files.',
      ],
      action: 'pickGameFolder',
    });
  }
  const version = game.gameVersion;
  if (version && compareVersions(version, MIN_GAME_VERSION) < 0) {
    return check('game', title, 'warn', `Found Stardew Valley ${version}, but collections need ${MIN_GAME_VERSION} or newer.`, {
      fixSteps: [
        'Open Steam (or GOG) and let it update Stardew Valley to the latest version.',
        'If Steam is set to an older "beta" branch, switch back: right-click Stardew Valley → Properties → Betas → None.',
        'Press "Re-check".',
      ],
    });
  }
  return check('game', title, 'pass', `Found Stardew Valley ${version ?? '(version unknown)'} at ${game.gamePath}`);
}

const SMAPI_INSTALL_STEPS = [...SMAPI_STEPS, `Close the Terminal window, come back here and press "${L.recheck}".`];

function smapiCheck(game: GameInfo | undefined, required: string | undefined): Check {
  const title = 'SMAPI (mod loader)';
  if (!game) {
    return check('smapi', title, 'fail', 'Find Stardew Valley first, then SMAPI can be checked.', {
      fixSteps: ['Fix the "Stardew Valley" check above first.', ...SMAPI_INSTALL_STEPS],
      fixUrl: SMAPI_URL,
    });
  }
  if (!game.smapiInstalled) {
    return check('smapi', title, 'fail', 'SMAPI is not installed. Stardew Valley needs it to load mods.', {
      fixSteps: SMAPI_INSTALL_STEPS,
      fixUrl: SMAPI_URL,
    });
  }
  const installed = game.smapiVersion;
  const update = { fixSteps: [`Update SMAPI to ${required} or newer. Installing over the old version is safe and keeps your mods.`, ...SMAPI_INSTALL_STEPS], fixUrl: SMAPI_URL };
  if (required && installed && compareVersions(installed, required) < 0) {
    // Play refuses to start with an older SMAPI, so this is not optional.
    return check('smapi', title, 'fail', `SMAPI ${installed} is installed; your collection needs ${required} or newer. Play is blocked until you update.`, update);
  }
  if (required && !installed) {
    return check('smapi', title, 'warn', `SMAPI is installed but its version couldn't be read; your collection needs SMAPI ${required} or newer.`, update);
  }
  return check('smapi', title, 'pass', `SMAPI ${installed ?? '(version unknown)'} is installed`);
}

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

const DISK_STEPS = [
  'Empty the Trash.',
  'Delete large files you no longer need, or remove old collections in Valley Loader\'s Profiles screen.',
  'See what is using space: Apple menu → System Settings → General → Storage.',
  'Press "Re-check".',
];

function diskCheck(free: number | undefined, collectionBytes: number): Check {
  const title = 'Free disk space';
  const needed = Math.max(collectionBytes * DISK_FACTOR, MIN_DISK_BYTES);
  const why = collectionBytes > 0 ? `about ${gb(needed)} needed for the download, unpacking and the installed mods` : `about ${gb(needed)} recommended`;
  if (free === undefined) {
    return check('disk', title, 'warn', `Couldn't read free disk space (${why}).`, {
      fixSteps: ['Check free space yourself: Apple menu → System Settings → General → Storage.', `Make sure at least ${gb(needed * 1.5)} is free.`, 'Press "Re-check".'],
    });
  }
  if (free < needed) {
    return check('disk', title, 'fail', `Only ${gb(free)} free; ${why}.`, { fixSteps: [`Free up at least ${gb(needed - free)}.`, ...DISK_STEPS] });
  }
  if (free < needed * 1.5) {
    return check('disk', title, 'warn', `${gb(free)} free; ${why}. That's tight.`, {
      fixSteps: [`Free up some space so at least ${gb(needed * 1.5)} is available.`, ...DISK_STEPS],
    });
  }
  return check('disk', title, 'pass', `${gb(free)} free (${why})`);
}

const API_KEY_STEPS = [
  'Sign in at nexusmods.com (create a free account if you don\'t have one).',
  `Open the API keys page: next.nexusmods.com/settings/api-keys (the "${L.help}" link takes you there).`,
  'Scroll down to "Personal API Key".',
  'Press "Generate" if there is no key yet, then press "Copy".',
  `Come back here, paste the key into the box below and press "${L.enterApiKey}".`,
  'Your key is stored encrypted in the macOS Keychain and is only used to talk to Nexus Mods. You can remove it any time.',
];

function apiKeyCheck({ hasApiKey, user, apiKeyError, apiKeyUnreachable }: PrereqInputs): Check {
  const title = 'Nexus Mods account';
  if (!hasApiKey) {
    return check('apiKey', title, 'fail', 'Not connected to Nexus Mods yet.', { fixSteps: API_KEY_STEPS, fixUrl: API_KEYS_URL, action: 'enterApiKey' });
  }
  if (apiKeyError) {
    return check('apiKey', title, 'fail', `Nexus Mods didn't accept your saved key: ${apiKeyError}`, {
      fixSteps: ['Your key may have been revoked or mistyped. Get a fresh one:', ...API_KEY_STEPS],
      fixUrl: API_KEYS_URL,
      action: 'enterApiKey',
    });
  }
  if (!user && apiKeyUnreachable !== undefined) {
    return check('apiKey', title, 'warn', `Couldn't reach Nexus Mods to check your key (${apiKeyUnreachable}).`, {
      fixSteps: [
        `Check your internet connection and press "${L.recheck}".`,
        'If nexusmods.com is down, try again later. Valley Loader needs it to download mods.',
        'If it keeps failing, your key may be wrong. Get a fresh one:',
        ...API_KEY_STEPS,
      ],
      fixUrl: API_KEYS_URL,
      action: 'enterApiKey',
    });
  }
  // Only before any check has run (the setup check re-validates, so it never stays here).
  if (!user) return check('apiKey', title, 'pending', 'Checking your key with Nexus Mods…');
  return check('apiKey', title, 'pass', `Signed in as ${user.name} (${user.isPremium ? 'Premium' : 'Free'})`);
}

function nexusLoginCheck(user: NexusUser | undefined, loggedIn: boolean | undefined): Check {
  const title = 'Nexus website sign-in';
  if (user?.isPremium) return check('nexusLogin', title, 'pass', 'Premium: downloads go straight through the API, no website clicks');
  if (loggedIn === true) return check('nexusLogin', title, 'pass', 'Signed in to nexusmods.com in the built-in window');
  const detail =
    loggedIn === false ? 'Not signed in to nexusmods.com in the built-in window.' : "You haven't signed in to nexusmods.com in the built-in window yet.";
  return check('nexusLogin', title, 'warn', detail, {
    fixSteps: [
      'Free Nexus accounts must click "Slow download" once for every mod. That is a Nexus rule, and Valley Loader never clicks for you.',
      'Valley Loader opens each mod\'s page in its own window and does everything else: downloading, unpacking and installing.',
      `Press "${L.openNexusLogin}" and sign in once. The window remembers you, so you won't need to do it again.`,
      `Close the window when you're signed in and press "${L.recheck}".`,
    ],
    action: 'openNexusLogin',
  });
}

function nxmHandlerCheck(registered: boolean): Check {
  const title = 'Browser download links';
  if (registered) return check('nxmHandler', title, 'pass', 'Nexus download links from any browser open in Valley Loader');
  return check('nxmHandler', title, 'warn', 'Optional: Valley Loader is not set to open Nexus download links.', {
    fixSteps: [
      'This lets "Slow download" clicks in Safari or Chrome reach Valley Loader too. The built-in Nexus window works without it.',
      `Press "${L.registerNxm}". If Vortex or another mod manager was handling these links on this Mac, Valley Loader takes over.`,
      `Press "${L.recheck}".`,
    ],
    action: 'registerNxm',
  });
}
