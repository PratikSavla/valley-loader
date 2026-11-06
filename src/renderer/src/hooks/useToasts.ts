// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type ToastTone = 'error' | 'info' | 'success';

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

export type PushToast = (message: string, tone?: ToastTone) => void;

const MAX_TOASTS = 4;

/** Small toast queue: identical messages replace each other, errors stay longer. */
export function useToasts(): { toasts: Toast[]; push: PushToast; dismiss: (id: number) => void } {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const handle = timers.current.get(id);
    if (handle !== undefined) {
      window.clearTimeout(handle);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback<PushToast>(
    (message, tone = 'info') => {
      const id = nextId.current;
      nextId.current += 1;
      setToasts((list) => [...list.filter((t) => t.message !== message), { id, message, tone }].slice(-MAX_TOASTS));
      const ms = tone === 'error' ? 9000 : 4500;
      timers.current.set(id, window.setTimeout(() => dismiss(id), ms));
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const handle of pending.values()) window.clearTimeout(handle);
      pending.clear();
    };
  }, []);

  return useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);
}
