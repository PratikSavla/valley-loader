// SPDX-License-Identifier: AGPL-3.0-only
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AppSnapshot, PlannedMod, ProfileState } from '@shared/types';
import { ApiKeyVault, NexusAuth, type SafeStorageLike } from '../src/main/nexus/auth';
import { Store } from '../src/main/state/store';
import { cleanupTempDirs, makeTempDir } from './helpers/archive-fixtures';

afterAll(cleanupTempDirs);

function mod(key: string, status: PlannedMod['status']): PlannedMod {
  return { key, name: key, version: '1', optional: false, selected: true, phase: 0, order: 0, sourceType: 'nexus', status, warnings: [] };
}

function profile(mods: PlannedMod[]): ProfileState {
  return {
    slug: 'abc', revision: 1, name: 'ABC', author: 'me', totalSize: 1, profileDir: '/p/abc', modsDir: '/p/abc/Mods',
    createdAt: 'x', updatedAt: 'x', running: true, mods,
  };
}

describe('Store', () => {
  it('persists settings/profiles atomically and resets transient state on reload', async () => {
    const dir = await makeTempDir('vl-store-');
    const store = await Store.open(dir, { saveDelayMs: 5, emitIntervalMs: 0 });
    store.upsertProfile(profile([mod('a', 'downloading'), mod('b', 'installed'), mod('c', 'needsClick')]));
    store.updateMod('abc', 'a', { progress: { received: 1, total: 2 } });
    store.setActive('abc');
    store.updateSettings({ dismissedHints: ['home-paste'] });
    store.setTransient({ hasApiKey: true, user: { userId: 1, name: 'u', isPremium: false, isSupporter: false }, lastError: 'x' });
    await store.flush();
    expect((await readdir(dir)).sort()).toEqual(['state.json']);
    const raw = await readFile(join(dir, 'state.json'), 'utf8');
    expect(raw).not.toMatch(/progress|lastError|"user"/);

    const again = await Store.open(dir);
    const p = again.requireProfile('abc');
    expect(p.running).toBe(false);
    expect(p.mods.map((m) => m.status)).toEqual(['pending', 'installed', 'needsClick']);
    expect(again.activeSlug).toBe('abc');
    expect(again.settings).toEqual({ onboardingComplete: false, dismissedHints: ['home-paste'], maxConcurrentDownloads: 3 });
    expect(again.snapshot().user).toBeUndefined();
    expect(again.snapshot().hasApiKey).toBe(false);
  });

  it('pushes snapshots to listeners and clears patched-out fields', async () => {
    const store = await Store.open(await makeTempDir('vl-store-'), { saveDelayMs: 5, emitIntervalMs: 0 });
    const seen: AppSnapshot[] = [];
    const off = store.subscribe((s) => seen.push(s));
    store.upsertProfile(profile([mod('a', 'failed')]));
    store.updateMod('abc', 'a', { error: 'boom' });
    store.updateMod('abc', 'a', { status: 'pending', error: undefined });
    await store.flush();
    off();
    const last = seen.at(-1);
    expect(last?.profiles[0]?.mods[0]?.status).toBe('pending');
    expect(last?.profiles[0]?.mods[0]).not.toHaveProperty('error');
    expect(() => store.requireMod('abc', 'zzz')).toThrow(/not part of collection/);
  });

  it('numbers every error event, so an identical repeated error is shown again', async () => {
    const store = await Store.open(await makeTempDir('vl-store-'), { saveDelayMs: 5, emitIntervalMs: 0 });
    store.setTransient({ lastError: 'Wrong folder' });
    const first = store.snapshot().lastErrorId;
    store.setTransient({ lastError: 'Wrong folder' });
    const second = store.snapshot().lastErrorId;
    expect(first).toBeDefined();
    expect(second).toBe((first ?? 0) + 1);
    store.setTransient({ game: undefined, lastError: undefined });
    expect(store.snapshot().lastErrorId).toBe(second);
    await store.flush();
  });

  it('moves a corrupt state.json aside and reports it', async () => {
    const dir = await makeTempDir('vl-store-');
    await writeFile(join(dir, 'state.json'), '{not json');
    const store = await Store.open(dir);
    expect(store.profiles).toEqual([]);
    expect(store.snapshot().lastError).toMatch(/reset \(backup: .*state\.json\.corrupt-/);
    expect((await readdir(dir)).some((f) => f.startsWith('state.json.corrupt-'))).toBe(true);
  });
});

/** Reversible fake: never leaves the key readable on disk. */
const fakeSafeStorage = (available = true): SafeStorageLike => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString('utf8'),
});

describe('NexusAuth', () => {
  const validJson = JSON.stringify({ user_id: 9, name: 'farmer', is_premium: true, key: 'KEY', email: 'e@x' });

  it('validates before saving, stores the key encrypted with mode 0600, and reloads it', async () => {
    const dir = await makeTempDir('vl-auth-');
    const sentKeys: string[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      sentKeys.push(new Headers(init?.headers).get('apikey') ?? '');
      return new Response(validJson, { status: 200 });
    }) as typeof fetch;
    const auth = new NexusAuth(new ApiKeyVault(dir, fakeSafeStorage()), { fetchImpl });
    const user = await auth.setApiKey('  secret-key-123 ');
    expect(user).toEqual({ userId: 9, name: 'farmer', isPremium: true, isSupporter: false });
    expect(sentKeys).toEqual(['secret-key-123']);
    const file = join(dir, 'nexus-key.bin');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readFile(file)).toString('utf8')).not.toContain('secret-key-123');
    const reloaded = new NexusAuth(new ApiKeyVault(dir, fakeSafeStorage()), { fetchImpl });
    expect(await reloaded.init()).toBe(true);
    await reloaded.clearApiKey();
    expect(reloaded.hasApiKey).toBe(false);
    expect(await new ApiKeyVault(dir, fakeSafeStorage()).load()).toBeUndefined();
  });

  it('saves nothing when Nexus rejects the key or encryption is unavailable', async () => {
    const dir = await makeTempDir('vl-auth-');
    const reject = (async () => new Response('{"message":"Please provide a valid API Key"}', { status: 401 })) as typeof fetch;
    const auth = new NexusAuth(new ApiKeyVault(dir, fakeSafeStorage()), { fetchImpl: reject });
    await expect(auth.setApiKey('bad-key')).rejects.toThrow();
    expect(auth.hasApiKey).toBe(false);
    expect(await readdir(dir)).toEqual([]);
    const ok = (async () => new Response(validJson, { status: 200 })) as typeof fetch;
    const locked = new NexusAuth(new ApiKeyVault(dir, fakeSafeStorage(false)), { fetchImpl: ok });
    await expect(locked.setApiKey('good-key')).rejects.toThrow(/Keychain encryption is not available/);
    expect(await readdir(dir)).toEqual([]);
  });
});
