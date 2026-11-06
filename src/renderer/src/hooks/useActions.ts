// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext } from 'react';
import type { ValleyApi } from '@shared/ipc';
import { runAction, type ActionResult } from '../lib/errors';
import { getValley } from './valley';
import type { PushToast } from './useToasts';

export interface RunOptions {
  /** false: log only, the caller shows the error inline instead of a toast. */
  toast?: boolean;
}

export interface Actions {
  /** Every window.valley call goes through here: errors are logged with context and surfaced, never swallowed. */
  run<T>(label: string, fn: (api: ValleyApi) => Promise<T>, options?: RunOptions): Promise<ActionResult<T>>;
  notify: PushToast;
  /** Opens an allowed help URL (nexusmods.com / smapi.io / stardewvalleywiki.com) in the system browser. */
  openLink(url: string): void;
}

export function createActions(push: PushToast): Actions {
  const run: Actions['run'] = (label, fn, options) =>
    runAction(
      label,
      () => fn(getValley()),
      (message, cause) => {
        console.error(`[valley] ${message}`, cause);
        if (options?.toast !== false) push(message, 'error');
      },
    );
  return {
    run,
    notify: push,
    openLink: (url) => {
      void run("Couldn't open link", (api) => api.openExternal(url));
    },
  };
}

export const ActionsContext = createContext<Actions | null>(null);

export function useActions(): Actions {
  const actions = useContext(ActionsContext);
  if (!actions) throw new Error('useActions must be used inside <ActionsContext.Provider>');
  return actions;
}
