import { useTranslation } from 'react-i18next';

import { useCredentialsSettings } from '@/modules/settings/hooks/useCredentialsSettings';
import { useForgeCredentials } from '@/modules/settings/hooks/useForgeCredentials';
import ApiKeysSection from '@/modules/settings/tabs/api-settings/sections/ApiKeysSection';
import ForgeCredentialsSection from '@/modules/settings/tabs/api-settings/sections/ForgeCredentialsSection';
import NewApiKeyAlert from '@/modules/settings/tabs/api-settings/sections/NewApiKeyAlert';
import type { GitForge } from '@/shared/types';

type ForgeCredentialsPanelProps = {
  forge: GitForge;
};

/** One forge's token section, wired to its own credential state. */
function ForgeCredentialsPanel({ forge }: ForgeCredentialsPanelProps) {
  const { t } = useTranslation('settings');
  const forgeCredentials = useForgeCredentials({
    forge,
    confirmDeleteText: t(`apiKeys.${forge}.confirmDelete`),
  });

  return (
    <ForgeCredentialsSection
      forge={forge}
      credentials={forgeCredentials.credentials}
      showNewForm={forgeCredentials.showNewForm}
      showNewTokenPlainText={forgeCredentials.showNewTokenPlainText}
      newName={forgeCredentials.newName}
      newToken={forgeCredentials.newToken}
      newDescription={forgeCredentials.newDescription}
      newInstanceUrl={forgeCredentials.newInstanceUrl}
      formError={forgeCredentials.formError}
      onShowNewFormChange={forgeCredentials.setShowNewForm}
      onNewNameChange={forgeCredentials.setNewName}
      onNewTokenChange={forgeCredentials.setNewToken}
      onNewDescriptionChange={forgeCredentials.setNewDescription}
      onNewInstanceUrlChange={forgeCredentials.setNewInstanceUrl}
      onToggleNewTokenVisibility={forgeCredentials.toggleNewTokenVisibility}
      onCreateCredential={forgeCredentials.createCredential}
      onCancelCreateCredential={forgeCredentials.cancelNewForm}
      onToggleCredential={forgeCredentials.toggleCredential}
      onDeleteCredential={forgeCredentials.deleteCredential}
    />
  );
}

/** Rendered by Settings for the "api" tab, managing CloudCLI API keys and GitHub / Forgejo credentials. */
export default function CredentialsSettingsTab() {
  const { t } = useTranslation('settings');
  const {
    apiKeys,
    loading,
    showNewKeyForm,
    setShowNewKeyForm,
    newKeyName,
    setNewKeyName,
    copiedKey,
    newlyCreatedKey,
    createApiKey,
    deleteApiKey,
    toggleApiKey,
    copyToClipboard,
    dismissNewlyCreatedKey,
    cancelNewApiKeyForm,
  } = useCredentialsSettings({
    confirmDeleteApiKeyText: t('apiKeys.confirmDelete'),
  });

  if (loading) {
    return <div className="text-muted-foreground">{t('apiKeys.loading')}</div>;
  }

  return (
    <div className="space-y-8">
      {newlyCreatedKey && (
        <NewApiKeyAlert
          apiKey={newlyCreatedKey}
          copiedKey={copiedKey}
          onCopy={copyToClipboard}
          onDismiss={dismissNewlyCreatedKey}
        />
      )}

      <ApiKeysSection
        apiKeys={apiKeys}
        showNewKeyForm={showNewKeyForm}
        newKeyName={newKeyName}
        onShowNewKeyFormChange={setShowNewKeyForm}
        onNewKeyNameChange={setNewKeyName}
        onCreateApiKey={createApiKey}
        onCancelCreateApiKey={cancelNewApiKeyForm}
        onToggleApiKey={toggleApiKey}
        onDeleteApiKey={deleteApiKey}
      />

      <ForgeCredentialsPanel forge="github" />

      <ForgeCredentialsPanel forge="forgejo" />
    </div>
  );
}
