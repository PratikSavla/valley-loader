// SPDX-License-Identifier: AGPL-3.0-only
import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSteamRunning, launchSmapi, smapiArgs } from '../src/main/game/launch';

type SpawnFn = typeof spawn;

interface FakeChild extends EventEmitter {
  unref: ReturnType<typeof vi.fn>;
}

interface Call {
  command: string;
  args: readonly string[];
  options: unknown;
}

/** Fake spawn whose child emits `event` (with `payload`) on the next tick. */
function fakeSpawn(event: 'spawn' | 'error' | 'close', payload?: unknown): { impl: SpawnFn; calls: Call[]; children: FakeChild[] } {
  const calls: Call[] = [];
  const children: FakeChild[] = [];
  const impl = ((command: string, args: readonly string[], options: unknown) => {
    calls.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    children.push(child);
    setImmediate(() => child.emit(event, payload));
    return child;
  }) as unknown as SpawnFn;
  return { impl, calls, children };
}

let tmp: string;
let gamePath: string;
let modsDir: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'valley launch-'));
  gamePath = join(tmp, 'Stardew Valley', 'Contents', 'MacOS');
  modsDir = join(tmp, 'Application Support', 'Valley Loader', 'profiles', 'tckf0m', 'Mods');
  await mkdir(gamePath, { recursive: true });
  await mkdir(modsDir, { recursive: true });
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('launchSmapi', () => {
  it('spawns the SMAPI apphost detached with --mods-path as a single argv entry', async () => {
    await writeFile(join(gamePath, 'StardewModdingAPI'), '#!/bin/sh\n', { mode: 0o755 });
    const { impl, calls, children } = fakeSpawn('spawn');
    await launchSmapi({ gamePath, modsDir, spawnImpl: impl });
    expect(calls).toEqual([
      {
        command: join(gamePath, 'StardewModdingAPI'),
        args: ['--mods-path', modsDir, '--no-terminal'],
        options: { cwd: gamePath, detached: true, stdio: 'ignore' },
      },
    ]);
    expect(children[0]?.unref).toHaveBeenCalledTimes(1);
    expect(smapiArgs('/a b/Mods')).toEqual(['--mods-path', '/a b/Mods', '--no-terminal']);
  });

  it('throws without spawning when the launcher is missing', async () => {
    const { impl, calls } = fakeSpawn('spawn');
    await expect(launchSmapi({ gamePath, modsDir, spawnImpl: impl })).rejects.toThrow(/SMAPI is not installed/);
    expect(calls).toHaveLength(0);
  });

  it('throws without spawning when the launcher is not executable', async () => {
    await writeFile(join(gamePath, 'StardewModdingAPI'), 'binary', { mode: 0o644 });
    const { impl, calls } = fakeSpawn('spawn');
    await expect(launchSmapi({ gamePath, modsDir, spawnImpl: impl })).rejects.toThrow(/not executable/);
    expect(calls).toHaveLength(0);
  });

  it('throws when the profile Mods folder does not exist', async () => {
    await writeFile(join(gamePath, 'StardewModdingAPI'), '#!/bin/sh\n', { mode: 0o755 });
    const { impl, calls } = fakeSpawn('spawn');
    await expect(launchSmapi({ gamePath, modsDir: join(tmp, 'gone'), spawnImpl: impl })).rejects.toThrow(/Mods folder is missing/);
    expect(calls).toHaveLength(0);
  });

  it('rejects with context when the process fails to start', async () => {
    await writeFile(join(gamePath, 'StardewModdingAPI'), '#!/bin/sh\n', { mode: 0o755 });
    const { impl, children } = fakeSpawn('error', new Error('EBADARCH'));
    await expect(launchSmapi({ gamePath, modsDir, spawnImpl: impl })).rejects.toThrow(/Could not start SMAPI at .*EBADARCH/);
    expect(children[0]?.unref).not.toHaveBeenCalled();
  });
});

describe('isSteamRunning', () => {
  it('runs pgrep -x steam_osx without a shell and maps exit 0 to true', async () => {
    const { impl, calls } = fakeSpawn('close', 0);
    expect(await isSteamRunning(impl)).toBe(true);
    expect(calls).toEqual([{ command: '/usr/bin/pgrep', args: ['-x', 'steam_osx'], options: { stdio: 'ignore' } }]);
  });

  it('maps exit 1 to false', async () => {
    const { impl } = fakeSpawn('close', 1);
    expect(await isSteamRunning(impl)).toBe(false);
  });

  it('throws on other exit codes and spawn errors', async () => {
    await expect(isSteamRunning(fakeSpawn('close', 2).impl)).rejects.toThrow(/exited with code 2/);
    await expect(isSteamRunning(fakeSpawn('error', new Error('ENOENT')).impl)).rejects.toThrow(/pgrep for steam_osx failed/);
  });
});
