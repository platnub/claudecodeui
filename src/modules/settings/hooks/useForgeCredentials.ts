import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';
import type { ForgeCredentialItem, GitForge } from '@/shared/types';

type ForgeCredentialsResponse = {
  credentials?: ForgeCredentialItem[];
  success?: boolean;
  error?: string | { message?: string };
};

type UseForgeCredentialsArgs = {
  forge: GitForge;
  confirmDeleteText: string;
};

/** The credential type each forge's tokens are stored under. */
const CREDENTIAL_TYPES: Record<GitForge, string> = {
  github: 'github_token',
  forgejo: 'forgejo_token',
};

const getApiError = (payload: ForgeCredentialsResponse | undefined, fallback: string) => {
  if (typeof payload?.error === 'string' && payload.error) {
    return payload.error;
  }
  if (payload?.error && typeof payload.error === 'object' && payload.error.message) {
    return payload.error.message;
  }
  return fallback;
};

/**
 * Lists, creates, toggles and deletes the stored tokens of one forge for the
 * credentials settings tab. A Forgejo token also carries the instance URL it
 * was issued by; the server validates it and reports why it was refused.
 */
export function useForgeCredentials({ forge, confirmDeleteText }: UseForgeCredentialsArgs) {
  const credentialType = CREDENTIAL_TYPES[forge];

  // The stored tokens of this forge, as listed by the server (never the secrets).
  const [credentials, setCredentials] = useState<ForgeCredentialItem[]>([]);
  // Whether the "add token" form is open.
  const [showNewForm, setShowNewForm] = useState(false);
  // The add-token form's fields.
  const [newName, setNewName] = useState('');
  const [newToken, setNewToken] = useState('');
  const [newDescription, setNewDescription] = useState('');
  // The Forgejo instance the new token belongs to (unused for GitHub).
  const [newInstanceUrl, setNewInstanceUrl] = useState('');
  // Whether the token being typed is shown in plain text.
  const [showNewTokenPlainText, setShowNewTokenPlainText] = useState(false);
  // The server's reason for refusing the last create, shown under the form.
  const [formError, setFormError] = useState<string | null>(null);

  const fetchCredentials = useCallback(async () => {
    try {
      const response = await api.settings.credentials(credentialType);
      const payload = await response.json() as ForgeCredentialsResponse;
      setCredentials(payload.credentials || []);
    } catch (error) {
      console.error(`Error fetching ${forge} credentials:`, error);
    }
  }, [credentialType, forge]);

  const resetForm = useCallback(() => {
    setShowNewForm(false);
    setNewName('');
    setNewToken('');
    setNewDescription('');
    setNewInstanceUrl('');
    setShowNewTokenPlainText(false);
    setFormError(null);
  }, []);

  const createCredential = useCallback(async () => {
    if (!newName.trim() || !newToken.trim() || (forge === 'forgejo' && !newInstanceUrl.trim())) {
      return;
    }

    try {
      setFormError(null);
      const response = await api.settings.createCredential({
        credentialName: newName.trim(),
        credentialType,
        credentialValue: newToken,
        description: newDescription.trim(),
        ...(forge === 'forgejo' ? { serviceUrl: newInstanceUrl.trim() } : {}),
      });

      const payload = await response.json() as ForgeCredentialsResponse;
      if (!response.ok || !payload.success) {
        setFormError(getApiError(payload, 'Failed to save the token'));
        return;
      }

      resetForm();
      await fetchCredentials();
    } catch (error) {
      console.error(`Error creating ${forge} credential:`, error);
      setFormError('Failed to save the token');
    }
  }, [credentialType, fetchCredentials, forge, newDescription, newInstanceUrl, newName, newToken, resetForm]);

  const deleteCredential = useCallback(async (credentialId: string) => {
    if (!window.confirm(confirmDeleteText)) {
      return;
    }

    try {
      const response = await api.settings.deleteCredential(credentialId);

      if (!response.ok) {
        const payload = await response.json() as ForgeCredentialsResponse;
        console.error(`Error deleting ${forge} credential:`, getApiError(payload, 'Failed to delete credential'));
        return;
      }

      await fetchCredentials();
    } catch (error) {
      console.error(`Error deleting ${forge} credential:`, error);
    }
  }, [confirmDeleteText, fetchCredentials, forge]);

  const toggleCredential = useCallback(async (credentialId: string, isActive: boolean) => {
    try {
      const response = await api.settings.toggleCredential(credentialId, !isActive);

      if (!response.ok) {
        const payload = await response.json() as ForgeCredentialsResponse;
        console.error(`Error toggling ${forge} credential:`, getApiError(payload, 'Failed to toggle credential'));
        return;
      }

      await fetchCredentials();
    } catch (error) {
      console.error(`Error toggling ${forge} credential:`, error);
    }
  }, [fetchCredentials, forge]);

  useEffect(() => {
    void fetchCredentials();
  }, [fetchCredentials]);

  return {
    credentials,
    showNewForm,
    setShowNewForm,
    newName,
    setNewName,
    newToken,
    setNewToken,
    newDescription,
    setNewDescription,
    newInstanceUrl,
    setNewInstanceUrl,
    showNewTokenPlainText,
    toggleNewTokenVisibility: () => setShowNewTokenPlainText((previous) => !previous),
    formError,
    createCredential,
    cancelNewForm: resetForm,
    deleteCredential,
    toggleCredential,
  };
}
