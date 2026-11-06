// SPDX-License-Identifier: AGPL-3.0-only
// Nexus API key handling: encrypted at rest with Electron safeStorage (macOS Keychain-backed) in
// <userData>/nexus-key.bin (mode 0600). The key is only ever held in memory here and never logged.
// safeStorage is injected (index.ts passes Electron's), so this module has no runtime Electron import.
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NexusUser } from '@shared/types';
import { NexusClient } from './api';

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export const KEY_FILE = 'nexus-key.bin';

function requireEncryption(storage: SafeStorageLike): void {
  if (!storage.isEncryptionAvailable()) {
    throw new Error('macOS Keychain encryption is not available, so the API key cannot be stored safely. Unlock your Mac login keychain and try again.');
  }
}

/** Encrypted on-disk store for the key. */
export class ApiKeyVault {
  readonly path: string;

  constructor(
    userDataDir: string,
    private readonly storage: SafeStorageLike,
  ) {
    this.path = join(userDataDir, KEY_FILE);
  }

  /** The stored key, or undefined if none is saved. Throws if the file exists but cannot be decrypted. */
  async load(): Promise<string | undefined> {
    let data: Buffer;
    try {
      data = await readFile(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error(`Could not read the saved API key file ${this.path}: ${(err as Error).message}`, { cause: err });
    }
    requireEncryption(this.storage);
    try {
      const key = this.storage.decryptString(data).trim();
      return key === '' ? undefined : key;
    } catch (err) {
      throw new Error('The saved Nexus API key could not be decrypted — enter it again in Settings.', { cause: err });
    }
  }

  async save(key: string): Promise<void> {
    requireEncryption(this.storage);
    const encrypted = this.storage.encryptString(key);
    const tmp = `${this.path}.tmp`;
    try {
      await writeFile(tmp, encrypted, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw new Error(`Could not save the API key to ${this.path}: ${(err as Error).message}`, { cause: err });
    }
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

export interface NexusAuthOptions {
  fetchImpl?: typeof fetch;
  appVersion?: string;
}

/** Holds the current key in memory and hands out NexusClients built with it. */
export class NexusAuth {
  #key: string | undefined;
  #client: NexusClient;

  constructor(
    private readonly vault: ApiKeyVault,
    private readonly opts: NexusAuthOptions = {},
  ) {
    this.#client = this.#makeClient(undefined);
  }

  /** Loads the saved key (if any). Returns whether a key is present. */
  async init(): Promise<boolean> {
    this.#key = await this.vault.load();
    this.#client = this.#makeClient(this.#key);
    return this.#key !== undefined;
  }

  get hasApiKey(): boolean {
    return this.#key !== undefined;
  }

  /** Client for the current key (or keyless for public GraphQL calls). */
  client(): NexusClient {
    return this.#client;
  }

  /** Validates `key` against Nexus BEFORE saving it; nothing is stored when validation fails. */
  async setApiKey(key: string): Promise<NexusUser> {
    const trimmed = key.trim();
    if (trimmed === '' || /\s/.test(trimmed)) {
      throw new Error('That API key looks wrong — copy the whole "Personal API Key" from nexusmods.com without spaces.');
    }
    const candidate = this.#makeClient(trimmed);
    const user = await candidate.validate();
    await this.vault.save(trimmed);
    this.#key = trimmed;
    this.#client = candidate;
    return user;
  }

  async clearApiKey(): Promise<void> {
    await this.vault.clear();
    this.#key = undefined;
    this.#client = this.#makeClient(undefined);
  }

  /** Re-validates the saved key (startup). */
  async validate(): Promise<NexusUser> {
    return this.#client.validate();
  }

  #makeClient(apiKey: string | undefined): NexusClient {
    const opts: ConstructorParameters<typeof NexusClient>[0] = {};
    if (apiKey !== undefined) opts.apiKey = apiKey;
    if (this.opts.fetchImpl) opts.fetchImpl = this.opts.fetchImpl;
    if (this.opts.appVersion) opts.appVersion = this.opts.appVersion;
    return new NexusClient(opts);
  }
}
