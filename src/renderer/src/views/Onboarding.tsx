// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import { useActions } from '../hooks/useActions';
import { Icon } from '../components/Icon';
import { ChecksStep } from './ChecksStep';
import { WelcomeStep } from './WelcomeStep';

type Step = 0 | 1 | 2;

const STEPS = ['Welcome', 'Setup check', 'Ready'] as const;
const HEADINGS = ['Welcome to Valley Loader', "Let's check your setup", "You're all set"] as const;

interface OnboardingProps {
  /** true when opened again from Settings after first-run setup. */
  rerun: boolean;
  account: { hasApiKey: boolean; userId: number | undefined; apiKeyError: string | undefined };
  /** Called after completeOnboarding() succeeds. */
  onFinish: () => void;
  onClose: () => void;
}

/** First-run wizard: Welcome → Setup checks → Done. Also reachable via Settings → Run setup check. */
export function Onboarding({ rerun, account, onFinish, onClose }: OnboardingProps) {
  const { run } = useActions();
  const [step, setStep] = useState<Step>(rerun ? 1 : 0);
  const [finishing, setFinishing] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const finish = async (): Promise<void> => {
    setFinishing(true);
    const result = await run("Couldn't finish setup", (api) => api.completeOnboarding());
    setFinishing(false);
    if (result.ok) onFinish();
  };

  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <div className="onboarding-brand">
          <span className="brand-mark">
            <Icon name="leaf" size={22} />
          </span>
          <span className="brand-name">Valley Loader</span>
          {rerun && (
            <button type="button" className="btn btn-quiet btn-small onboarding-close" onClick={onClose}>
              Close
            </button>
          )}
        </div>
        <ol className="stepper" aria-label="Setup progress">
          {STEPS.map((label, i) => (
            <li key={label} className={i < step ? 'done' : i === step ? 'current' : ''} aria-current={i === step ? 'step' : undefined}>
              <span className="step-dot">{i < step ? <Icon name="check" size={12} /> : i + 1}</span>
              {label}
            </li>
          ))}
        </ol>
        <h1 ref={headingRef} tabIndex={-1}>
          {HEADINGS[step]}
        </h1>
        {step === 0 && <WelcomeStep onNext={() => setStep(1)} />}
        {step === 1 && <ChecksStep account={account} onBack={() => setStep(0)} onNext={() => setStep(2)} />}
        {step === 2 && (
          <>
            <p className="lead">Your Mac is ready for modded Stardew Valley.</p>
            <ol className="hint-steps done-steps">
              <li>Find a collection on nexusmods.com and copy its link.</li>
              <li>Paste it into Valley Loader and press Install.</li>
              <li>Press Start, follow the prompts, then press Play.</li>
            </ol>
            <div className="wizard-actions">
              <button type="button" className="btn btn-quiet" onClick={() => setStep(1)}>
                Back
              </button>
              <button type="button" className="btn btn-primary btn-large" onClick={() => void finish()} disabled={finishing}>
                {rerun ? 'Back to my collections' : 'Paste your first collection'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
