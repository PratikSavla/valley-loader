// SPDX-License-Identifier: AGPL-3.0-only
// Error text + a wrapper that turns any rejected IPC call into a typed result the UI surfaces.

const IPC_PREFIX = /^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/;

/** Readable message from anything thrown; strips Electron's "Error invoking remote method …" noise. */
export function errorMessage(cause: unknown): string {
  let message: string;
  if (cause instanceof Error) message = cause.message;
  else if (typeof cause === 'string') message = cause;
  else message = 'Something went wrong.';
  const stripped = message.replace(IPC_PREFIX, '').trim();
  return stripped === '' ? 'Something went wrong.' : stripped;
}

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Runs `fn`; on rejection builds "<label>: <message>", hands it to `report` (which logs and toasts)
 * and returns it as `{ ok: false }` so callers can also show it inline. Never throws.
 */
export async function runAction<T>(
  label: string,
  fn: () => Promise<T>,
  report: (message: string, cause: unknown) => void,
): Promise<ActionResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (cause) {
    const error = `${label}: ${errorMessage(cause)}`;
    report(error, cause);
    return { ok: false, error };
  }
}
