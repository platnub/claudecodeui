import { Key, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Input } from '@/shared/ui';
import type { ForgeTokenCredential, GitForge, TokenMode } from '@/shared/types';

type RepositoryAuthenticationCardProps = {
  forge: GitForge;
  tokenMode: TokenMode;
  selectedToken: string;
  newToken: string;
  availableTokens: ForgeTokenCredential[];
  loadingTokens: boolean;
  tokenLoadError: string | null;
  onTokenModeChange: (tokenMode: TokenMode) => void;
  onSelectedTokenChange: (tokenId: string) => void;
  onNewTokenChange: (tokenValue: string) => void;
};

/** The translation keys and token placeholder that differ between forges. */
const FORGE_COPY: Record<GitForge, {
  titleKey: string;
  optionalTokenKey: string;
  tokenPlaceholder: string;
  publicTokenPlaceholderKey: string;
}> = {
  github: {
    titleKey: 'projectWizard.step2.githubAuth',
    optionalTokenKey: 'projectWizard.step2.optionalTokenPublic',
    tokenPlaceholder: 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    publicTokenPlaceholderKey: 'projectWizard.step2.tokenPublicPlaceholder',
  },
  forgejo: {
    titleKey: 'projectWizard.step2.forgejoAuth',
    optionalTokenKey: 'projectWizard.step2.optionalTokenPublicForgejo',
    tokenPlaceholder: 'Forgejo access token',
    publicTokenPlaceholderKey: 'projectWizard.step2.tokenPublicPlaceholderForgejo',
  },
};

const getModeClassName = (mode: TokenMode, selectedMode: TokenMode) =>
  `px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
    mode === selectedMode
      ? mode === 'none'
        ? 'bg-green-500 text-white'
        : 'bg-blue-500 text-white'
      : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
  }`;

/** Rendered by StepConfiguration to choose the GitHub or Forgejo token used when cloning a repository. */
export default function RepositoryAuthenticationCard({
  forge,
  tokenMode,
  selectedToken,
  newToken,
  availableTokens,
  loadingTokens,
  tokenLoadError,
  onTokenModeChange,
  onSelectedTokenChange,
  onNewTokenChange,
}: RepositoryAuthenticationCardProps) {
  const { t } = useTranslation();
  const copy = FORGE_COPY[forge];

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/50">
      <div className="mb-4 flex items-start gap-3">
        <Key className="mt-0.5 h-5 w-5 flex-shrink-0 text-gray-600 dark:text-gray-400" />
        <div className="flex-1">
          <h5 className="mb-1 font-medium text-gray-900 dark:text-white">
            {t(copy.titleKey)}
          </h5>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('projectWizard.step2.githubAuthHelp')}
          </p>
        </div>
      </div>

      {loadingTokens && (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('projectWizard.step2.loadingTokens')}
        </div>
      )}

      {!loadingTokens && tokenLoadError && (
        <p className="mb-3 text-sm text-red-600 dark:text-red-400">{tokenLoadError}</p>
      )}

      {!loadingTokens && availableTokens.length > 0 && (
        <>
          <div className="mb-4 grid grid-cols-3 gap-2">
            <button
              onClick={() => onTokenModeChange('stored')}
              className={getModeClassName(tokenMode, 'stored')}
            >
              {t('projectWizard.step2.storedToken')}
            </button>
            <button
              onClick={() => onTokenModeChange('new')}
              className={getModeClassName(tokenMode, 'new')}
            >
              {t('projectWizard.step2.newToken')}
            </button>
            <button
              onClick={() => {
                onTokenModeChange('none');
                onSelectedTokenChange('');
                onNewTokenChange('');
              }}
              className={getModeClassName(tokenMode, 'none')}
            >
              {t('projectWizard.step2.nonePublic')}
            </button>
          </div>

          {tokenMode === 'stored' ? (
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('projectWizard.step2.selectToken')}
              </label>
              <select
                value={selectedToken}
                onChange={(event) => onSelectedTokenChange(event.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
              >
                <option value="">{t('projectWizard.step2.selectTokenPlaceholder')}</option>
                {availableTokens.map((token) => (
                  <option key={token.id} value={String(token.id)}>
                    {token.credential_name}
                  </option>
                ))}
              </select>
            </div>
          ) : tokenMode === 'new' ? (
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('projectWizard.step2.newToken')}
              </label>
              <Input
                type="password"
                value={newToken}
                onChange={(event) => onNewTokenChange(event.target.value)}
                placeholder={copy.tokenPlaceholder}
                className="w-full"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t('projectWizard.step2.tokenHelp')}
              </p>
            </div>
          ) : null}
        </>
      )}

      {!loadingTokens && availableTokens.length === 0 && (
        <div className="space-y-4">
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-900/20">
            <p className="text-sm text-blue-800 dark:text-blue-200">
              {t('projectWizard.step2.publicRepoInfo')}
            </p>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              {t(copy.optionalTokenKey)}
            </label>
            <Input
              type="password"
              value={newToken}
              onChange={(event) => {
                const tokenValue = event.target.value;
                onNewTokenChange(tokenValue);
                onTokenModeChange(tokenValue.trim() ? 'new' : 'none');
              }}
              placeholder={t(copy.publicTokenPlaceholderKey)}
              className="w-full"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('projectWizard.step2.noTokensHelp')}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
