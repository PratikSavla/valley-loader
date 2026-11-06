// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import type { PlannedMod, PrereqCheck } from '@shared/types';
import { errorMessage, runAction } from '../src/renderer/src/lib/errors';
import { formatBytes, formatProgress, percent, plural, sourceLabel, statusLabel, statusTone } from '../src/renderer/src/lib/format';
import { PREREQ_BUTTON_LABELS } from '@shared/prereqLabels';
import { checkCollectionInput, onboardingGate, prereqActionLabel, setupGaps, wizardNote } from '../src/renderer/src/lib/guidance';
import { filterMods, playReadiness, profileStats, profileStatus, sortedMods } from '../src/renderer/src/lib/profile';
import { compareVersions, smapiState } from '../src/renderer/src/lib/version';

function mod(overrides: Partial<PlannedMod> & Pick<PlannedMod, 'key'>): PlannedMod {
  return {
    name: overrides.key,
    version: '1.0.0',
    optional: false,
    selected: true,
    phase: 0,
    order: 0,
    sourceType: 'nexus',
    status: 'pending',
    warnings: [],
    ...overrides,
  };
}

function check(id: PrereqCheck['id'], status: PrereqCheck['status']): PrereqCheck {
  return { id, title: id, status, detail: '', fixSteps: [] };
}

describe('formatBytes', () => {
  it('formats each unit range with sensible precision', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('2 KB');
    expect(formatBytes(4.2 * 1024 * 1024)).toBe('4.2 MB');
    expect(formatBytes(465 * 1024 * 1024)).toBe('465 MB');
    expect(formatBytes(1.25 * 1024 ** 3)).toBe('1.3 GB');
  });
  it('rolls over instead of printing 1024 of a unit', () => {
    expect(formatBytes(1024 * 1024 - 10)).toBe('1.0 MB');
  });
  it('returns a dash for unknown or invalid sizes', () => {
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
  it('formats download progress and percentages', () => {
    expect(formatProgress(1024 * 1024, 4 * 1024 * 1024)).toBe('1.0 MB of 4.0 MB');
    expect(formatProgress(2048, 0)).toBe('2 KB received');
    expect(percent(50, 200)).toBe(25);
    expect(percent(300, 200)).toBe(100);
    expect(percent(5, 0)).toBeUndefined();
  });
});

describe('labels', () => {
  it('maps statuses and sources to friendly text and tones', () => {
    expect(statusLabel('needsClick')).toBe('Needs your click');
    expect(statusTone('failed')).toBe('bad');
    expect(statusTone('downloading')).toBe('busy');
    expect(statusTone('installed')).toBe('ok');
    expect(sourceLabel('bundle')).toBe('Bundled');
    expect(plural(1, 'mod')).toBe('1 mod');
    expect(plural(3, 'mod')).toBe('3 mods');
  });
});

describe('compareVersions / smapiState', () => {
  it('compares numerically, not lexically', () => {
    expect(compareVersions('4.1.10', '4.1.9')).toBeGreaterThan(0);
    expect(compareVersions('4.0', '4.0.0')).toBe(0);
    expect(compareVersions('v3.18.6', '4.0.0')).toBeLessThan(0);
    expect(compareVersions('4.0.0-beta.2', '4.0.0')).toBeLessThan(0);
  });
  it('reports missing/outdated/ok SMAPI against a requirement', () => {
    const base = { gamePath: '/g', smapiInstalled: true, smapiVersion: '4.0.8' };
    expect(smapiState(undefined, '4.1.0')).toEqual({ kind: 'unknown' });
    expect(smapiState({ ...base, smapiInstalled: false }, '4.1.0')).toEqual({ kind: 'missing', required: '4.1.0' });
    expect(smapiState(base, '4.1.0')).toEqual({ kind: 'outdated', required: '4.1.0', installed: '4.0.8' });
    expect(smapiState(base, '4.0.8')).toEqual({ kind: 'ok' });
    expect(smapiState(base, undefined)).toEqual({ kind: 'ok' });
  });
});

describe('profile helpers', () => {
  const mods = [
    mod({ key: 'a', status: 'installed', fileSize: 100, order: 2 }),
    mod({ key: 'b', status: 'failed', fileSize: 50, order: 1 }),
    mod({ key: 'c', status: 'skipped', optional: true, selected: false, fileSize: 999, order: 0 }),
    mod({ key: 'd', status: 'downloading', fileSize: 10, order: 3, warnings: ['root mod'] }),
  ];

  it('counts only selected mods toward progress and size', () => {
    const s = profileStats({ mods });
    expect(s.total).toBe(4);
    expect(s.selected).toBe(3);
    expect(s.installed).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.busy).toBe(1);
    expect(s.selectedBytes).toBe(160);
    expect(s.optionalCount).toBe(1);
    expect(s.counts.skipped).toBe(1);
  });

  it('is ready only when every selected mod is installed', () => {
    const done = mods.map((m) => (m.selected ? { ...m, status: 'installed' as const } : m));
    expect(playReadiness({ mods: done, running: false })).toBe('ready');
    expect(profileStatus({ mods: done, running: false })).toEqual({ text: 'Ready to play', tone: 'ok' });
  });

  it('allows playing with confirmation when some failed and nothing is in flight', () => {
    const settled = mods.map((m) => (m.key === 'd' ? { ...m, status: 'installed' as const } : m));
    expect(playReadiness({ mods: settled, running: false })).toBe('partial');
    expect(playReadiness({ mods, running: false })).toBe('incomplete'); // d still downloading
    expect(playReadiness({ mods: settled, running: true })).toBe('incomplete');
    expect(profileStatus({ mods: settled, running: false }).text).toBe('Needs attention');
  });

  it('headlines a running install that is waiting on a click', () => {
    const waiting = [mod({ key: 'x', status: 'needsClick' }), mod({ key: 'y' })];
    expect(profileStatus({ mods: waiting, running: true })).toEqual({ text: 'Waiting for your click', tone: 'warn' });
    expect(profileStatus({ mods: waiting, running: false }).text).toBe('Not started');
  });

  it('sorts by deploy order without mutating and filters by need', () => {
    const ordered = sortedMods(mods);
    expect(ordered.map((m) => m.key)).toEqual(['c', 'b', 'a', 'd']);
    expect(mods[0]?.key).toBe('a');
    expect(filterMods(ordered, 'attention').map((m) => m.key)).toEqual(['b', 'd']);
    expect(filterMods(ordered, 'remaining').map((m) => m.key)).toEqual(['b', 'd']);
    expect(filterMods(ordered, 'all')).toHaveLength(4);
  });
});

describe('guidance', () => {
  it('accepts collection URLs, bare slugs and nxm links', () => {
    expect(checkCollectionInput('  https://www.nexusmods.com/games/stardewvalley/collections/tckf0m ')).toEqual({
      ok: true,
      value: 'https://www.nexusmods.com/games/stardewvalley/collections/tckf0m',
    });
    expect(checkCollectionInput('tckf0m').ok).toBe(true);
    expect(checkCollectionInput('nxm://stardewvalley/collections/tckf0m/revisions/114').ok).toBe(true);
  });
  it('explains common mistakes', () => {
    const empty = checkCollectionInput('   ');
    expect(empty.ok).toBe(false);
    expect(!empty.ok && empty.error).toMatch(/paste a collection link/i);
    const singleMod = checkCollectionInput('https://www.nexusmods.com/stardewvalley/mods/2400');
    expect(!singleMod.ok && singleMod.error).toMatch(/single mod page/);
    const otherGame = checkCollectionInput('https://www.nexusmods.com/games/skyrimspecialedition/collections/abc123');
    expect(!otherGame.ok && otherGame.error).toMatch(/only installs Stardew Valley/);
    const junk = checkCollectionInput('hello there');
    expect(!junk.ok && junk.error).toMatch(/doesn't look like a collection link/);
  });
  it('lists setup gaps from the snapshot', () => {
    expect(setupGaps({ hasApiKey: false, game: undefined }).map((g) => g.id)).toEqual(['apiKey', 'game']);
    expect(setupGaps({ hasApiKey: true, game: { gamePath: '/g', smapiInstalled: false } }).map((g) => g.id)).toEqual(['smapi']);
    expect(setupGaps({ hasApiKey: true, game: { gamePath: '/g', smapiInstalled: true } })).toEqual([]);
    const rejected = setupGaps({ hasApiKey: true, apiKeyError: 'Invalid API key', game: { gamePath: '/g', smapiInstalled: true } });
    expect(rejected).toEqual([{ id: 'apiKey', text: expect.stringMatching(/rejected your saved API key/) }]);
  });
  it('labels setup-check buttons with the words their fix steps use', () => {
    for (const action of ['pickGameFolder', 'enterApiKey', 'openNexusLogin', 'registerNxm'] as const) {
      expect(prereqActionLabel(action)).toBe(PREREQ_BUTTON_LABELS[action]);
    }
  });
  it('explains why Continue is still locked', () => {
    expect(wizardNote(onboardingGate([check('smapi', 'fail')]))).toMatch(/Needs fixing/);
    expect(wizardNote(onboardingGate([check('apiKey', 'pending')]))).toMatch(/Still checking.*Re-check/);
  });
  it('lets onboarding continue only when nothing fails or is pending', () => {
    expect(onboardingGate(undefined).canContinue).toBe(false);
    expect(onboardingGate([]).canContinue).toBe(false);
    expect(onboardingGate([check('game', 'pass'), check('nxmHandler', 'warn')])).toEqual({ canContinue: true, fails: 0, warns: 1, pending: 0 });
    expect(onboardingGate([check('game', 'pass'), check('smapi', 'fail')]).canContinue).toBe(false);
    expect(onboardingGate([check('game', 'pending')]).canContinue).toBe(false);
  });
});

describe('errors', () => {
  it('strips the Electron IPC prefix', () => {
    const e = new Error("Error invoking remote method 'valley:set-api-key': Error: Invalid API key");
    expect(errorMessage(e)).toBe('Invalid API key');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage({})).toBe('Something went wrong.');
  });
  it('runAction returns values and reports labelled failures without throwing', async () => {
    const report = vi.fn();
    await expect(runAction('Label', async () => 42, report)).resolves.toEqual({ ok: true, value: 42 });
    expect(report).not.toHaveBeenCalled();
    const cause = new Error("Error invoking remote method 'valley:x': TypeError: boom");
    const result = await runAction('Couldn\'t do it', () => Promise.reject(cause), report);
    expect(result).toEqual({ ok: false, error: "Couldn't do it: boom" });
    expect(report).toHaveBeenCalledWith("Couldn't do it: boom", cause);
  });
});
