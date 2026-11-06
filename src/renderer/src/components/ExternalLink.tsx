// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { useActions } from '../hooks/useActions';
import { Icon } from './Icon';

/** Link that opens in the system browser through window.valley.openExternal (main allow-lists domains). */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  const { openLink } = useActions();
  return (
    <a
      className="ext-link"
      href={href}
      onClick={(event) => {
        event.preventDefault();
        openLink(href);
      }}
    >
      {children}
      <Icon name="external" size={14} />
      <span className="sr-only"> (opens in your browser)</span>
    </a>
  );
}
