// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState, type FormEvent } from 'react';
import type { NexusUser } from '@shared/types';
import { useActions } from '../hooks/useActions';
import { ExternalLink } from './ExternalLink';

const API_KEYS_URL = 'https://next.nexusmods.com/settings/api-keys';

interface ApiKeyFormProps {
  onSaved?: (user: NexusUser) => void;
  submitLabel?: string;
}

/** Password-type field for the personal Nexus API key. Shows the rejection reason inline. */
export function ApiKeyForm({ onSaved, submitLabel = 'Save key' }: ApiKeyFormProps) {
  const { run, notify } = useActions();
  const [key, setKey] = useState('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const inputId = useId();
  const helpId = useId();
  const errorId = useId();

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const trimmed = key.trim();
    if (trimmed === '') {
      setError('Paste your API key first.');
      return;
    }
    setSaving(true);
    setError(undefined);
    const result = await run("Couldn't save the API key", (api) => api.setApiKey(trimmed), { toast: false });
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setKey('');
    notify(`Signed in as ${result.value.name}`, 'success');
    onSaved?.(result.value);
  };

  return (
    <form className="api-key-form" onSubmit={(e) => void submit(e)} noValidate>
      <label htmlFor={inputId}>Nexus personal API key</label>
      <div className="inline-field">
        <input
          id={inputId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          aria-describedby={error ? `${helpId} ${errorId}` : helpId}
          aria-invalid={error ? true : undefined}
          disabled={saving}
        />
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Checking…' : submitLabel}
        </button>
      </div>
      <p id={helpId} className="field-help">
        On Nexus, open <ExternalLink href={API_KEYS_URL}>Site preferences → API Keys</ExternalLink> and copy the{' '}
        <strong>Personal API Key</strong> at the bottom. It is stored encrypted in your macOS Keychain.
      </p>
      {error && (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
