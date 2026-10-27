import { Eye, EyeOff, GitBranch, Github, Plus, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '@/shared/ui';
import type { ForgeCredentialItem, GitForge } from '@/shared/types';

type ForgeCredentialsSectionProps = {
  forge: GitForge;
  credentials: ForgeCredentialItem[];
  showNewForm: boolean;
  showNewTokenPlainText: boolean;
  newName: string;
  newToken: string;
  newDescription: string;
  /** The Forgejo instance a new token belongs to; only rendered for Forgejo. */
  newInstanceUrl: string;
  formError: string | null;
  onShowNewFormChange: (value: boolean) => void;
  onNewNameChange: (value: string) => void;
  onNewTokenChange: (value: string) => void;
  onNewDescriptionChange: (value: string) => void;
  onNewInstanceUrlChange: (value: string) => void;
  onToggleNewTokenVisibility: () => void;
  onCreateCredential: () => void;
  onCancelCreateCredential: () => void;
  onToggleCredential: (credentialId: string, isActive: boolean) => void;
  onDeleteCredential: (credentialId: string) => void;
};

/** The icon and the "how to create a token" link of each forge's section. */
const FORGE_SECTION: Record<GitForge, { icon: LucideIcon; howToUrl: string }> = {
  github: { icon: Github, howToUrl: 'https://github.com/settings/tokens' },
  forgejo: {
    icon: GitBranch,
    howToUrl: 'https://forgejo.org/docs/latest/user/token-scope/',
  },
};

/** Rendered by CredentialsSettingsTab, once per forge, to list, create and delete stored GitHub or Forgejo tokens. */
export default function ForgeCredentialsSection({
  forge,
  credentials,
  showNewForm,
  showNewTokenPlainText,
  newName,
  newToken,
  newDescription,
  newInstanceUrl,
  formError,
  onShowNewFormChange,
  onNewNameChange,
  onNewTokenChange,
  onNewDescriptionChange,
  onNewInstanceUrlChange,
  onToggleNewTokenVisibility,
  onCreateCredential,
  onCancelCreateCredential,
  onToggleCredential,
  onDeleteCredential,
}: ForgeCredentialsSectionProps) {
  const { t } = useTranslation('settings');
  const { icon: ForgeIcon, howToUrl } = FORGE_SECTION[forge];
  const keyPrefix = `apiKeys.${forge}`;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ForgeIcon className="h-5 w-5" />
          <h3 className="text-lg font-semibold">{t(`${keyPrefix}.title`)}</h3>
        </div>
        <Button size="sm" onClick={() => onShowNewFormChange(!showNewForm)}>
          <Plus className="mr-1 h-4 w-4" />
          {t(`${keyPrefix}.addButton`)}
        </Button>
      </div>

      <p className="mb-4 text-sm text-muted-foreground">{t(`${keyPrefix}.descriptionAlt`)}</p>

      {showNewForm && (
        <div className="mb-4 space-y-3 rounded-lg border bg-card p-4">
          <Input
            placeholder={t(`${keyPrefix}.form.namePlaceholder`)}
            value={newName}
            onChange={(event) => onNewNameChange(event.target.value)}
          />

          {forge === 'forgejo' && (
            <Input
              type="url"
              placeholder={t('apiKeys.forgejo.form.instanceUrlPlaceholder')}
              value={newInstanceUrl}
              onChange={(event) => onNewInstanceUrlChange(event.target.value)}
            />
          )}

          <div className="relative">
            <Input
              type={showNewTokenPlainText ? 'text' : 'password'}
              placeholder={t(`${keyPrefix}.form.tokenPlaceholder`)}
              value={newToken}
              onChange={(event) => onNewTokenChange(event.target.value)}
              className="pr-10"
            />
            <button
              type="button"
              onClick={onToggleNewTokenVisibility}
              aria-label={showNewTokenPlainText ? t('common:misc.hideToken') : t('common:misc.showToken')}
              className="absolute right-3 top-2.5 text-muted-foreground hover:text-foreground"
            >
              {showNewTokenPlainText ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          <Input
            placeholder={t(`${keyPrefix}.form.descriptionPlaceholder`)}
            value={newDescription}
            onChange={(event) => onNewDescriptionChange(event.target.value)}
          />

          {formError && <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>}

          <div className="flex gap-2">
            <Button onClick={onCreateCredential}>{t(`${keyPrefix}.form.addButton`)}</Button>
            <Button variant="outline" onClick={onCancelCreateCredential}>
              {t(`${keyPrefix}.form.cancelButton`)}
            </Button>
          </div>

          <a
            href={howToUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block text-xs text-primary hover:underline"
          >
            {t(`${keyPrefix}.form.howToCreate`)}
          </a>
        </div>
      )}

      <div className="space-y-2">
        {credentials.length === 0 ? (
          <p className="text-sm italic text-muted-foreground">{t(`${keyPrefix}.empty`)}</p>
        ) : (
          credentials.map((credential) => (
            <div key={credential.id} className="flex items-center justify-between rounded-lg border p-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{credential.credential_name}</div>
                {credential.service_url && (
                  <div className="truncate font-mono text-xs text-muted-foreground">{credential.service_url}</div>
                )}
                {credential.description && (
                  <div className="text-xs text-muted-foreground">{credential.description}</div>
                )}
                <div className="mt-1 text-xs text-muted-foreground">
                  {t(`${keyPrefix}.added`)} {new Date(credential.created_at).toLocaleDateString()}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant={credential.is_active ? 'outline' : 'secondary'}
                  onClick={() => onToggleCredential(credential.id, credential.is_active)}
                >
                  {credential.is_active ? t('apiKeys.status.active') : t('apiKeys.status.inactive')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onDeleteCredential(credential.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
