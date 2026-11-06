// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from 'react';
import { useActions } from '../hooks/useActions';
import { Icon } from './Icon';

interface HintProps {
  id: string;
  title: string;
  dismissedHints: readonly string[];
  children: ReactNode;
}

/** Friendly contextual tip. Hidden once its id is in settings.dismissedHints. */
export function Hint({ id, title, dismissedHints, children }: HintProps) {
  const { run } = useActions();
  const [hiding, setHiding] = useState(false);
  if (hiding || dismissedHints.includes(id)) return null;

  const dismiss = async (): Promise<void> => {
    setHiding(true);
    const result = await run("Couldn't hide this tip", (api) => api.dismissHint(id));
    if (!result.ok) setHiding(false);
  };

  return (
    <aside className="hint" aria-label={`Tip: ${title}`}>
      <span className="hint-icon">
        <Icon name="bulb" size={20} />
      </span>
      <div className="hint-body">
        <p className="hint-title">{title}</p>
        <div className="hint-text">{children}</div>
      </div>
      <button type="button" className="btn btn-quiet btn-small hint-dismiss" onClick={() => void dismiss()}>
        Got it
      </button>
    </aside>
  );
}
