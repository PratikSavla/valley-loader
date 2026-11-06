// SPDX-License-Identifier: AGPL-3.0-only
import type { Tone } from '../lib/format';
import { Icon, type IconName } from './Icon';

const TONE_ICONS: Record<Tone, IconName> = {
  ok: 'check',
  warn: 'alert',
  bad: 'cross',
  busy: 'clock',
  idle: 'clock',
};

/** Coloured pill with an icon so status is never conveyed by colour alone. */
export function StatusChip({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className={`chip chip-${tone}`}>
      <Icon name={TONE_ICONS[tone]} size={13} />
      {label}
    </span>
  );
}
