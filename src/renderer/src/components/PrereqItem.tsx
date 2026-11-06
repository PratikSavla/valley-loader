// SPDX-License-Identifier: AGPL-3.0-only
import { PREREQ_BUTTON_LABELS } from '@shared/prereqLabels';
import type { PrereqCheck } from '@shared/types';
import { checkLabel, checkTone } from '../lib/format';
import { prereqActionLabel } from '../lib/guidance';
import { ApiKeyForm } from './ApiKeyForm';
import { ExternalLink } from './ExternalLink';
import { StatusChip } from './StatusChip';

export type PrereqAction = NonNullable<PrereqCheck['action']>;

interface PrereqItemProps {
  check: PrereqCheck;
  busy: boolean;
  onAction: (action: PrereqAction) => void;
  onKeySaved: () => void;
}

/** One setup check: status, detail, numbered fix steps, help link and its fix action. */
export function PrereqItem({ check, busy, onAction, onKeySaved }: PrereqItemProps) {
  const tone = checkTone(check.status);
  const needsFix = check.status === 'fail' || check.status === 'warn';
  const action = needsFix ? check.action : undefined;
  return (
    <li className={`prereq prereq-${tone}`}>
      <div className="prereq-head">
        <h3>{check.title}</h3>
        <StatusChip tone={tone} label={checkLabel(check.status)} />
      </div>
      <p className="prereq-detail">{check.detail}</p>
      {needsFix && check.fixSteps.length > 0 && (
        <ol className="fix-steps">
          {check.fixSteps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      )}
      {needsFix && check.fixUrl && (
        <p>
          <ExternalLink href={check.fixUrl}>{PREREQ_BUTTON_LABELS.help}</ExternalLink>
        </p>
      )}
      {action === 'enterApiKey' && <ApiKeyForm submitLabel={PREREQ_BUTTON_LABELS.enterApiKey} onSaved={onKeySaved} />}
      {action && action !== 'enterApiKey' && (
        <div className="prereq-actions">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onAction(action)}>
            {prereqActionLabel(action)}
          </button>
          {action === 'openNexusLogin' && (
            <span className="muted small">After signing in, close that window and press Re-check.</span>
          )}
        </div>
      )}
    </li>
  );
}
