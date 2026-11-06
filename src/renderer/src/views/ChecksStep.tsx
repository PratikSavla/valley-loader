// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useState } from 'react';
import type { PrereqCheck } from '@shared/types';
import type { ActionResult } from '../lib/errors';
import { onboardingGate, wizardNote } from '../lib/guidance';
import { plural } from '../lib/format';
import { useActions } from '../hooks/useActions';
import { Icon } from '../components/Icon';
import { PrereqItem, type PrereqAction } from '../components/PrereqItem';

interface ChecksStepProps {
  onBack: () => void;
  onNext: () => void;
  /** From the snapshot: the checks re-run when the key is saved/removed or the background key check finishes. */
  account: { hasApiKey: boolean; userId: number | undefined; apiKeyError: string | undefined };
}

export function ChecksStep({ onBack, onNext, account }: ChecksStepProps) {
  const { run, notify } = useActions();
  const [checks, setChecks] = useState<PrereqCheck[]>();
  const [loadError, setLoadError] = useState<string>();
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => run("Couldn't run the setup checks", (api) => api.runPrereqChecks()), [run]);
  const apply = useCallback((result: ActionResult<PrereqCheck[]>) => {
    setChecking(false);
    if (result.ok) {
      setChecks(result.value);
      setLoadError(undefined);
    } else {
      setLoadError(result.error);
    }
  }, []);

  const { hasApiKey, userId, apiKeyError } = account;
  useEffect(() => {
    let alive = true;
    void load().then((result) => {
      if (alive) apply(result);
    });
    return () => {
      alive = false;
    };
  }, [load, apply, hasApiKey, userId, apiKeyError]);

  const recheck = async (): Promise<void> => {
    setChecking(true);
    apply(await load());
  };

  const act = async (action: PrereqAction): Promise<void> => {
    setBusy(true);
    if (action === 'pickGameFolder') {
      // A wrong folder throws (and is toasted by run); undefined only means the picker was cancelled.
      await run("Couldn't set the game folder", (api) => api.pickGameFolder());
    } else if (action === 'openNexusLogin') {
      await run("Couldn't open the Nexus window", (api) => api.openNexusLogin());
    } else if (action === 'registerNxm') {
      const r = await run("Couldn't register for Nexus links", (api) => api.registerNxmHandler());
      if (r.ok && !r.value) notify('macOS did not accept the change. You can skip this one.', 'info');
    }
    setBusy(false);
    if (action !== 'openNexusLogin') await recheck();
  };

  const gate = onboardingGate(checks);
  return (
    <>
      <p className="lead">Valley Loader checks everything a modded game needs. Fix anything marked red, then press Continue.</p>
      <div className="checks-toolbar" aria-live="polite">
        <span className="muted">
          {checking
            ? 'Checking…'
            : checks
              ? `${plural(checks.length - gate.fails - gate.warns - gate.pending, 'check')} passed${gate.fails ? `, ${gate.fails} to fix` : ''}${gate.warns ? `, ${gate.warns} optional` : ''}`
              : ''}
        </span>
        <button type="button" className="btn btn-secondary" onClick={() => void recheck()} disabled={checking}>
          <Icon name="refresh" size={14} /> Re-check
        </button>
      </div>
      {loadError && (
        <p className="field-error" role="alert">
          {loadError}
        </p>
      )}
      {checks && (
        <ul className="prereq-list" aria-busy={checking}>
          {checks.map((check) => (
            <PrereqItem key={check.id} check={check} busy={busy || checking} onAction={(a) => void act(a)} onKeySaved={() => void recheck()} />
          ))}
        </ul>
      )}
      {gate.canContinue && gate.warns > 0 && (
        <p className="callout">
          <Icon name="alert" size={18} />
          <span>Some items are marked “worth fixing”. You can fix these later from Settings → Run setup check.</span>
        </p>
      )}
      <div className="wizard-actions">
        <button type="button" className="btn btn-quiet" onClick={onBack}>
          Back
        </button>
        <button type="button" className="btn btn-primary btn-large" onClick={onNext} disabled={!gate.canContinue}>
          Continue
        </button>
      </div>
      {!gate.canContinue && !checking && checks && <p className="muted small wizard-note">{wizardNote(gate)}</p>}
    </>
  );
}
