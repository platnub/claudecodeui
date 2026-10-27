import { useCallback, useMemo, useState } from 'react';
import { FolderPlus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import ErrorBanner from '@/modules/project-creation-wizard/ErrorBanner';
import StepConfiguration from '@/modules/project-creation-wizard/StepConfiguration';
import StepReview from '@/modules/project-creation-wizard/StepReview';
import WizardFooter from '@/modules/project-creation-wizard/WizardFooter';
import WizardProgress from '@/modules/project-creation-wizard/WizardProgress';
import { useForgeDetection } from '@/modules/project-creation-wizard/hooks/useForgeDetection';
import { useForgeTokens } from '@/modules/project-creation-wizard/hooks/useForgeTokens';
import { cloneWorkspaceWithProgress, createProjectRequest } from '@/modules/project-creation-wizard/utils/workspaceApi';
import { isCloneWorkflow, shouldShowRepositoryAuthentication } from '@/modules/project-creation-wizard/utils/pathUtils';
import type { ForgeSelection, TokenMode, WizardFormState, WizardStep } from '@/shared/types';

type ProjectCreationWizardProps = {
  onClose: () => void;
  onProjectCreated?: (project?: Record<string, unknown>) => void;
};

const initialFormState: WizardFormState = {
  workspacePath: '',
  repositoryUrl: '',
  forgeSelection: 'auto',
  tokenMode: 'stored',
  selectedToken: '',
  newToken: '',
};

/** Rendered by the sidebar module's modal layer to create a new project or clone one from GitHub or Forgejo. */
export default function ProjectCreationWizard({
  onClose,
  onProjectCreated,
}: ProjectCreationWizardProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<WizardStep>(1);
  const [formState, setFormState] = useState<WizardFormState>(initialFormState);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cloneProgress, setCloneProgress] = useState('');

  const shouldLoadTokens =
    step === 1 && shouldShowRepositoryAuthentication(formState.repositoryUrl);

  // Detection keeps running for ssh URLs too: the review step names the host.
  const { detected, detecting: detectingForge } = useForgeDetection(
    formState.repositoryUrl,
    isCloneWorkflow(formState.repositoryUrl),
  );
  const effectiveForge = formState.forgeSelection === 'auto'
    ? detected.forge
    : formState.forgeSelection;

  const autoSelectToken = useCallback((tokenId: string) => {
    setFormState((previous) => ({ ...previous, selectedToken: tokenId }));
  }, []);

  const {
    tokens: availableTokens,
    loading: loadingTokens,
    loadError: tokenLoadError,
    selectedTokenName,
  } = useForgeTokens({
    shouldLoad: shouldLoadTokens,
    forge: effectiveForge,
    repositoryUrl: formState.repositoryUrl,
    instanceUrl: effectiveForge === 'forgejo' ? detected.instanceUrl : null,
    detecting: detectingForge,
    selectedTokenId: formState.selectedToken,
    onAutoSelectToken: autoSelectToken,
  });

  // Keep cross-step values in this component; local UI state lives in child components.
  const updateField = useCallback(<K extends keyof WizardFormState>(key: K, value: WizardFormState[K]) => {
    setFormState((previous) => ({ ...previous, [key]: value }));
  }, []);

  const updateTokenMode = useCallback(
    (tokenMode: TokenMode) => updateField('tokenMode', tokenMode),
    [updateField],
  );

  const handleNext = useCallback(() => {
    setError(null);

    if (step === 1) {
      if (!formState.workspacePath.trim()) {
        setError(t('projectWizard.errors.providePath'));
        return;
      }
      setStep(2);
    }
  }, [formState.workspacePath, step, t]);

  const handleBack = useCallback(() => {
    setError(null);
    setStep((previousStep) => (previousStep > 1 ? ((previousStep - 1) as WizardStep) : previousStep));
  }, []);

  // A clone waits for detection to settle: until then the forge (and so the
  // token sent with the clone) may still be the one of the URL before the edit.
  const isWaitingForHost = isCloneWorkflow(formState.repositoryUrl) && detectingForge;

  const handleCreate = useCallback(async () => {
    if (isWaitingForHost) {
      return;
    }
    setIsCreating(true);
    setError(null);
    setCloneProgress('');

    try {
      const shouldCloneRepository = isCloneWorkflow(formState.repositoryUrl);

      if (shouldCloneRepository) {
        // No token for a host that is neither GitHub nor Forgejo: the server
        // would refuse to guess where it may send it.
        const hasForge = effectiveForge !== null;
        const project = await cloneWorkspaceWithProgress(
          {
            workspacePath: formState.workspacePath,
            repositoryUrl: formState.repositoryUrl,
            forge: formState.forgeSelection === 'auto' ? null : formState.forgeSelection,
            tokenMode: hasForge ? formState.tokenMode : 'none',
            selectedToken: formState.selectedToken,
            newToken: formState.newToken,
          },
          {
            onProgress: setCloneProgress,
          },
        );

        onProjectCreated?.(project);
        onClose();
        return;
      }

      const project = await createProjectRequest({
        path: formState.workspacePath.trim(),
      });

      onProjectCreated?.(project);
      onClose();
    } catch (createError) {
      const errorMessage =
        createError instanceof Error
          ? createError.message
          : t('projectWizard.errors.failedToCreate');
      setError(errorMessage);
    } finally {
      setIsCreating(false);
    }
  }, [effectiveForge, formState, isWaitingForHost, onClose, onProjectCreated, t]);

  const shouldCloneRepository = useMemo(
    () => isCloneWorkflow(formState.repositoryUrl),
    [formState.repositoryUrl],
  );

  return (
    <div className="fixed bottom-0 left-0 right-0 top-0 z-[60] flex items-center justify-center bg-black/50 p-0 backdrop-blur-sm sm:p-4">
      <div className="h-full w-full overflow-y-auto rounded-none border-0 border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800 sm:h-auto sm:max-w-2xl sm:rounded-lg sm:border">
        <div className="flex items-center justify-between border-b border-gray-200 p-6 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/50">
              <FolderPlus className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            </div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              {t('projectWizard.title')}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            disabled={isCreating}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <WizardProgress step={step} />

        <div className="min-h-[300px] space-y-6 p-6">
          {error && <ErrorBanner message={error} />}

          {step === 1 && (
            <StepConfiguration
              workspacePath={formState.workspacePath}
              repositoryUrl={formState.repositoryUrl}
              forgeSelection={formState.forgeSelection}
              detectedForge={detected.forge}
              detectingForge={detectingForge}
              effectiveForge={effectiveForge}
              tokenMode={formState.tokenMode}
              selectedToken={formState.selectedToken}
              newToken={formState.newToken}
              availableTokens={availableTokens}
              loadingTokens={loadingTokens}
              tokenLoadError={tokenLoadError}
              isCreating={isCreating}
              onWorkspacePathChange={(workspacePath) => updateField('workspacePath', workspacePath)}
              onRepositoryUrlChange={(repositoryUrl) => updateField('repositoryUrl', repositoryUrl)}
              onForgeSelectionChange={(forgeSelection: ForgeSelection) =>
                updateField('forgeSelection', forgeSelection)
              }
              onTokenModeChange={updateTokenMode}
              onSelectedTokenChange={(selectedToken) => updateField('selectedToken', selectedToken)}
              onNewTokenChange={(newToken) => updateField('newToken', newToken)}
              onAdvanceToConfirm={() => setStep(2)}
            />
          )}

          {step === 2 && (
            <StepReview
              formState={formState}
              effectiveForge={effectiveForge}
              detectingForge={detectingForge}
              selectedTokenName={selectedTokenName}
              isCreating={isCreating}
              cloneProgress={cloneProgress}
            />
          )}
        </div>

        <WizardFooter
          step={step}
          isCreating={isCreating}
          isWaitingForHost={isWaitingForHost}
          isCloneWorkflow={shouldCloneRepository}
          onClose={onClose}
          onBack={handleBack}
          onNext={handleNext}
          onCreate={handleCreate}
        />
      </div>
    </div>
  );
}
