import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { isSshGitUrl } from '@/modules/project-creation-wizard/utils/pathUtils';
import type { GitForge, WizardFormState } from '@/shared/types';

type StepReviewProps = {
  formState: WizardFormState;
  /** The forge the clone will use, or null when the host is neither GitHub nor Forgejo. */
  effectiveForge: GitForge | null;
  selectedTokenName: string | null;
  isCreating: boolean;
  cloneProgress: string;
};

/** Rendered by ProjectCreationWizard as step 2, summarising the chosen configuration and streaming clone progress. */
export default function StepReview({
  formState,
  effectiveForge,
  selectedTokenName,
  isCreating,
  cloneProgress,
}: StepReviewProps) {
  const { t } = useTranslation();

  const authenticationLabel = useMemo(() => {
    if (formState.tokenMode === 'stored' && formState.selectedToken) {
      return `${t('projectWizard.step3.usingStoredToken')} ${selectedTokenName || t('common:misc.unknownProvider')}`;
    }

    if (formState.tokenMode === 'new' && formState.newToken.trim()) {
      return t('projectWizard.step3.usingProvidedToken');
    }

    if (isSshGitUrl(formState.repositoryUrl)) {
      return t('projectWizard.step3.sshKey', { defaultValue: 'SSH Key' });
    }

    return t('projectWizard.step3.noAuthentication');
  }, [formState, selectedTokenName, t]);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/50">
        <h4 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">
          {t('projectWizard.step3.reviewConfig')}
        </h4>

        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-gray-600 dark:text-gray-400">{t('projectWizard.step3.path')}</span>
            <span className="break-all font-mono text-xs text-gray-900 dark:text-white">
              {formState.workspacePath}
            </span>
          </div>

          {formState.repositoryUrl && (
            <>
              <div className="flex justify-between text-sm">
                <span className="text-gray-600 dark:text-gray-400">
                  {t('projectWizard.step3.cloneFrom')}
                </span>
                <span className="break-all font-mono text-xs text-gray-900 dark:text-white">
                  {formState.repositoryUrl}
                </span>
              </div>

              <div className="flex justify-between text-sm">
                <span className="text-gray-600 dark:text-gray-400">
                  {t('projectWizard.step3.host')}
                </span>
                <span className="text-xs text-gray-900 dark:text-white">
                  {effectiveForge === 'github'
                    ? t('projectWizard.step2.forgeGithub')
                    : effectiveForge === 'forgejo'
                      ? t('projectWizard.step2.forgeForgejo')
                      : t('projectWizard.step3.otherHost')}
                </span>
              </div>

              <div className="flex justify-between text-sm">
                <span className="text-gray-600 dark:text-gray-400">
                  {t('projectWizard.step3.authentication')}
                </span>
                <span className="text-xs text-gray-900 dark:text-white">{authenticationLabel}</span>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-900/20">
        {isCreating && cloneProgress ? (
          <div className="space-y-2">
            <p className="text-sm font-medium text-blue-800 dark:text-blue-200">
              {t('projectWizard.step3.cloningRepository', { defaultValue: 'Cloning repository...' })}
            </p>
            <code className="block whitespace-pre-wrap break-all font-mono text-xs text-blue-700 dark:text-blue-300">
              {cloneProgress}
            </code>
          </div>
        ) : (
          <p className="text-sm text-blue-800 dark:text-blue-200">
            {formState.repositoryUrl
              ? t('projectWizard.step3.newWithClone')
              : t('projectWizard.step3.newEmpty')}
          </p>
        )}
      </div>
    </div>
  );
}
