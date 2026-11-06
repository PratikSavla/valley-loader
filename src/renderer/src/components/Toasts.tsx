// SPDX-License-Identifier: AGPL-3.0-only
import type { Toast } from '../hooks/useToasts';
import { Icon } from './Icon';

/** Toast stack. The container is a polite live region so screen readers announce new messages. */
export function Toasts({ toasts, onDismiss }: { toasts: readonly Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" aria-live="polite" aria-relevant="additions" role="status">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.tone}`}>
          <Icon name={toast.tone === 'error' ? 'alert' : 'check'} size={18} />
          <p>{toast.message}</p>
          <button type="button" className="toast-close" onClick={() => onDismiss(toast.id)} aria-label="Dismiss message">
            <Icon name="cross" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
