// SPDX-License-Identifier: AGPL-3.0-only
// Global typing for the bridge exposed by src/preload/index.ts via contextBridge.
import type { ValleyApi } from '@shared/ipc';

declare global {
  interface Window {
    valley: ValleyApi;
  }
}

export {};
