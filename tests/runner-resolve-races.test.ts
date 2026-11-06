// SPDX-License-Identifier: AGPL-3.0-only
// Re-resolving a collection (manual link or one-click update) while the user acts on the same profile.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProfileUpdate, RevisionDiff } from '@shared/types';
import { cleanupTempDirs } from './helpers/archive-fixtures';
import { buildFixtures, deferred, makeHarness, settleHarnesses, type Fixtures, type Harness } from './helpers/runner-harness';

let fx: Fixtures;
beforeAll(async () => {
  fx = await buildFixtures();
});
afterAll(async () => {
  await settleHarnesses();
  await cleanupTempDirs();
});

/** Resolves testcol at revision 3, then points the client at revision 4 with the archive download held open. */
async function stalledUpdate(): Promise<{ h: Harness; reached: Promise<void>; release: () => void }> {
  const h = await makeHarness(fx);
  await h.runner.resolveCollection('testcol');
  h.client.summary = { ...fx.summary, revision: 4 };
  const gate = deferred();
  const hit = deferred();
  const original = h.client.getCollectionArchiveUrl.bind(h.client);
  h.client.getCollectionArchiveUrl = async () => {
    hit.open();
    await gate.promise;
    return original();
  };
  return { h, reached: hit.promise, release: gate.open };
}

describe('Runner holds a per-collection lock while resolving', () => {
  it('refuses Start, Remove, toggles and a second resolve until the update is done', async () => {
    const { h, reached, release } = await stalledUpdate();
    const resolving = h.runner.resolveCollection('testcol');
    await reached;
    expect(h.store.snapshot().resolving).toEqual(['testcol']);
    await expect(h.runner.startInstall('testcol')).rejects.toThrow(/is being updated/);
    await expect(h.runner.removeProfile('testcol')).rejects.toThrow(/is being updated/);
    await expect(h.runner.setModSelected('testcol', 'nexus:103:3003', true)).rejects.toThrow(/is being updated/);
    await expect(h.runner.retryMod('testcol', 'nexus:101:1001')).rejects.toThrow(/is being updated/);
    await expect(h.runner.resolveCollection('testcol')).rejects.toThrow(/is being updated/);
    release();
    expect((await resolving).revision).toBe(4);
    expect(h.store.snapshot().resolving).toBeUndefined();
    expect(h.store.requireProfile('testcol').running).toBe(false);
  });
});

describe('resolveCollection re-checks the profile after the archive download', () => {
  it('does not bring back a profile removed meanwhile', async () => {
    const { h, reached, release } = await stalledUpdate();
    const resolving = h.runner.resolveCollection('testcol');
    await reached;
    h.store.removeProfile('testcol'); // bypasses the Runner lock on purpose
    release();
    await expect(resolving).rejects.toThrow(/was removed while it was being updated/);
    expect(h.store.getProfile('testcol')).toBeUndefined();
  });

  it('does not overwrite a profile that started installing meanwhile', async () => {
    const { h, reached, release } = await stalledUpdate();
    const resolving = h.runner.resolveCollection('testcol');
    await reached;
    h.store.updateProfile('testcol', { running: true });
    release();
    await expect(resolving).rejects.toThrow(/started installing while it was being updated/);
    expect(h.store.requireProfile('testcol')).toMatchObject({ revision: 3, running: true });
    h.store.updateProfile('testcol', { running: false });
  });
});

describe('resolveCollection keeps a known newer revision', () => {
  const diff: RevisionDiff = { fromRevision: 3, toRevision: 5, added: [], removed: [], changed: [], unchanged: 3, clicksNeeded: 0 };
  const known: ProfileUpdate = { latestRevision: 5, checkedAt: '2026-11-06T10:00:00.000Z', diff };

  it('keeps latestRevision and the diff when re-resolving the revision the diff is from', async () => {
    const h = await makeHarness(fx);
    await h.runner.resolveCollection('testcol');
    h.store.updateProfile('testcol', { update: known });
    const again = await h.runner.resolveCollection('testcol');
    expect(again.update).toEqual(known);
  });

  it('keeps latestRevision but drops a diff from another revision, and drops it all once caught up', async () => {
    const h = await makeHarness(fx);
    await h.runner.resolveCollection('testcol');
    h.store.updateProfile('testcol', { update: known });
    h.client.summary = { ...fx.summary, revision: 4 };
    const middle = await h.runner.resolveCollection('testcol');
    expect(middle.update).toEqual({ latestRevision: 5, checkedAt: known.checkedAt });
    h.client.summary = { ...fx.summary, revision: 5 };
    const latest = await h.runner.resolveCollection('testcol');
    expect(latest.update).toBeUndefined();
  });
});
