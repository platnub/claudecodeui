import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Input } from '@/shared/ui';
import { shouldShowRepositoryAuthentication } from '@/modules/project-creation-wizard/utils/pathUtils';
import type {
  ForgeSelection,
  ForgeTokenCredential,
  GitForge,
  TokenMode,
} from '@/shared/types';
import RepositoryAuthenticationCard from '@/modules/project-creation-wizard/RepositoryAuthenticationCard';
import WorkspacePathField from '@/modules/project-creation-wizard/WorkspacePathField';

type StepConfigurationProps = {
  workspacePath: string;
  repositoryUrl: string;
  forgeSelection: ForgeSelection;
  /** The forge auto-detection found for the URL (null: neither, or not known yet). */
  detectedForge: GitForge | null;
  detectingForge: boolean;
  /** The forge the clone will use: the user's choice, else the detected one. */
  effectiveForge: GitForge | null;
  tokenMode: TokenMode;
  selectedToken: string;
  newToken: string;
  availableTokens: ForgeTokenCredential[];
  loadingTokens: boolean;
  tokenLoadError: string | null;
  isCreating: boolean;
  onWorkspacePathChange: (workspacePath: string) => void;
  onRepositoryUrlChange: (repositoryUrl: string) => void;
  onForgeSelectionChange: (forgeSelection: ForgeSelection) => void;
  onTokenModeChange: (tokenMode: TokenMode) => void;
  onSelectedTokenChange: (tokenId: string) => void;
  onNewTokenChange: (tokenValue: string) => void;
  onAdvanceToConfirm: () => void;
};

const FORGE_LABEL_KEYS: Record<GitForge, string> = {
  github: 'projectWizard.step2.forgeGithub',
  forgejo: 'projectWizard.step2.forgeForgejo',
};

/** Rendered by ProjectCreationWizard as step 1, collecting the workspace path, clone URL, its host and the clone's authentication. */
export default function StepConfiguration({
  workspacePath,
  repositoryUrl,
  forgeSelection,
  detectedForge,
  detectingForge,
  effectiveForge,
  tokenMode,
  selectedToken,
  newToken,
  availableTokens,
  loadingTokens,
  tokenLoadError,
  isCreating,
  onWorkspacePathChange,
  onRepositoryUrlChange,
  onForgeSelectionChange,
  onTokenModeChange,
  onSelectedTokenChange,
  onNewTokenChange,
  onAdvanceToConfirm,
}: StepConfigurationProps) {
  const { t } = useTranslation();
  const hasRepositoryUrl = repositoryUrl.trim().length > 0;
  const showAuthentication = shouldShowRepositoryAuthentication(repositoryUrl);

  const autoDetectLabel = (() => {
    if (!hasRepositoryUrl) {
      return t('projectWizard.step2.forgeAuto');
    }
    if (detectingForge) {
      return t('projectWizard.step2.forgeDetecting');
    }
    return t('projectWizard.step2.forgeAutoDetected', {
      forge: detectedForge
        ? t(FORGE_LABEL_KEYS[detectedForge])
        : t('projectWizard.step2.forgeUnknown'),
    });
  })();

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('projectWizard.step2.newPath')}
        </label>

        <WorkspacePathField
          value={workspacePath}
          disabled={isCreating}
          onChange={onWorkspacePathChange}
          onAdvanceToConfirm={onAdvanceToConfirm}
        />

        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t('projectWizard.step2.newHelp')}
        </p>
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('projectWizard.step2.repositoryUrl')}
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            type="text"
            value={repositoryUrl}
            onChange={(event) => onRepositoryUrlChange(event.target.value)}
            placeholder={t('projectWizard.step2.repositoryPlaceholder')}
            className="w-full sm:flex-1"
            disabled={isCreating}
          />
          <div className="relative sm:w-56">
            <select
              aria-label={t('projectWizard.step2.forgeLabel')}
              value={forgeSelection}
              onChange={(event) => onForgeSelectionChange(event.target.value as ForgeSelection)}
              disabled={isCreating || !hasRepositoryUrl}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm disabled:opacity-60 dark:border-gray-600 dark:bg-gray-800"
            >
              <option value="auto">{autoDetectLabel}</option>
              <option value="github">{t('projectWizard.step2.forgeGithub')}</option>
              <option value="forgejo">{t('projectWizard.step2.forgeForgejo')}</option>
            </select>
            {detectingForge && forgeSelection === 'auto' && (
              <Loader2 className="pointer-events-none absolute right-8 top-2.5 h-4 w-4 animate-spin text-gray-400" />
            )}
          </div>
        </div>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t('projectWizard.step2.repositoryHelp')}
        </p>
      </div>

      {showAuthentication && effectiveForge && (
        <RepositoryAuthenticationCard
          forge={effectiveForge}
          tokenMode={tokenMode}
          selectedToken={selectedToken}
          newToken={newToken}
          availableTokens={availableTokens}
          loadingTokens={loadingTokens}
          tokenLoadError={tokenLoadError}
          onTokenModeChange={onTokenModeChange}
          onSelectedTokenChange={onSelectedTokenChange}
          onNewTokenChange={onNewTokenChange}
        />
      )}

      {showAuthentication && !effectiveForge && !detectingForge && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-900/50 dark:text-gray-400">
          {t('projectWizard.step2.forgeUnknownHelp')}
        </div>
      )}
    </div>
  );
}
