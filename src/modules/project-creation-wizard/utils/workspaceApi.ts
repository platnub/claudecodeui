import { api } from '@/shared/api';
import { FORGE_CREDENTIAL_TYPES } from '@/shared/constants';
import type {
  FolderSuggestion,
  ForgeDetectionResult,
  ForgeTokenCredential,
  GitForge,
  TokenMode,
} from '@/shared/types';

type CredentialsResponse = {
  credentials?: ForgeTokenCredential[];
  error?: string;
};

type BrowseFilesystemResponse = {
  path?: string;
  suggestions?: FolderSuggestion[];
  error?: string;
};

type CreateFolderResponse = {
  success?: boolean;
  path?: string;
  error?: string;
  details?: string;
};

type CreateProjectPayload = {
  path: string;
  customName?: string;
};

type CreateProjectApiError = {
  code?: string;
  message?: string;
  details?: unknown;
};

type CreateProjectResponse = {
  success?: boolean;
  project?: Record<string, unknown>;
  error?: string | CreateProjectApiError;
  details?: string;
  message?: string;
};

type CloneProgressEvent = {
  type?: string;
  message?: string;
  project?: Record<string, unknown>;
};

type CloneWorkspaceParams = {
  workspacePath: string;
  repositoryUrl: string;
  /** The forge the user picked; null lets the server detect it from the URL. */
  forge: GitForge | null;
  tokenMode: TokenMode;
  selectedToken: string;
  newToken: string;
};

type CloneProgressHandlers = {
  onProgress: (message: string) => void;
};

const parseJson = async <T>(response: Response): Promise<T> => {
  const data = (await response.json()) as T;
  return data;
};

const resolveCreateProjectErrorMessage = (responseData: CreateProjectResponse): string | null => {
  if (typeof responseData.details === 'string' && responseData.details.trim().length > 0) {
    return responseData.details;
  }

  if (typeof responseData.error === 'string' && responseData.error.trim().length > 0) {
    return responseData.error;
  }

  if (responseData.error && typeof responseData.error === 'object') {
    const errorObject = responseData.error as { message?: unknown; details?: unknown };

    if (typeof errorObject.details === 'string' && errorObject.details.trim().length > 0) {
      return errorObject.details;
    }

    if (typeof errorObject.message === 'string' && errorObject.message.trim().length > 0) {
      return errorObject.message;
    }

    if (
      errorObject.details
      && typeof errorObject.details === 'object'
      && typeof (errorObject.details as { projectPath?: unknown }).projectPath === 'string'
    ) {
      return `Project path already exists: ${(errorObject.details as { projectPath: string }).projectPath}`;
    }
  }

  if (typeof responseData.message === 'string' && responseData.message.trim().length > 0) {
    return responseData.message;
  }

  return null;
};

// Loads the active GitHub and Forgejo tokens together; the wizard filters them
// by the forge (and Forgejo instance) the repository URL resolves to.
export const fetchForgeTokenCredentials = async () => {
  const credentialLists = await Promise.all(
    Object.values(FORGE_CREDENTIAL_TYPES).map(async (credentialType) => {
      const response = await api.settings.credentials(credentialType);
      const data = await parseJson<CredentialsResponse>(response);

      if (!response.ok) {
        throw new Error(data.error || 'Failed to load stored tokens');
      }

      return data.credentials || [];
    }),
  );

  return credentialLists.flat().filter((credential) => credential.is_active);
};

// Whether a credential row is a token for the given forge.
export const isCredentialForForge = (credential: ForgeTokenCredential, forge: GitForge) =>
  credential.credential_type === FORGE_CREDENTIAL_TYPES[forge];

// Asks the server which forge a repository URL lives on (it knows the user's
// stored Forgejo instances and can probe an unknown host).
export const detectRepositoryForge = async (repositoryUrl: string): Promise<ForgeDetectionResult> => {
  const response = await api.detectRepositoryForge(repositoryUrl);
  const data = await parseJson<Partial<ForgeDetectionResult> & { error?: string }>(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to detect the repository host');
  }

  return { forge: data.forge ?? null, instanceUrl: data.instanceUrl ?? null };
};

export const browseFilesystemFolders = async (pathToBrowse: string) => {
  const response = await api.browseFilesystem(pathToBrowse);
  const data = await parseJson<BrowseFilesystemResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to browse filesystem');
  }

  return {
    path: data.path || pathToBrowse,
    suggestions: (data.suggestions || []) as FolderSuggestion[],
  };
};

export const createFolderInFilesystem = async (folderPath: string) => {
  const response = await api.createFolder(folderPath);
  const data = await parseJson<CreateFolderResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to create folder');
  }

  return data.path || folderPath;
};

export const createProjectRequest = async (payload: CreateProjectPayload) => {
  const response = await api.createProject(payload);
  const data = await parseJson<CreateProjectResponse>(response);

  if (!response.ok) {
    throw new Error(resolveCreateProjectErrorMessage(data) || 'Failed to create project');
  }

  return data.project;
};

type StartCloneResponse = {
  cloneId?: string;
  error?: string | CreateProjectApiError;
};

// Submits the clone details — token included — in a request body and returns
// the id the progress stream is opened with, so the token never enters a URL.
const startClone = async ({
  workspacePath,
  repositoryUrl,
  forge,
  tokenMode,
  selectedToken,
  newToken,
}: CloneWorkspaceParams) => {
  const response = await api.startProjectClone({
    path: workspacePath.trim(),
    repositoryUrl: repositoryUrl.trim(),
    forge,
    tokenId: tokenMode === 'stored' && selectedToken ? Number(selectedToken) : null,
    newToken: tokenMode === 'new' ? newToken.trim() : null,
  });
  const data = await parseJson<StartCloneResponse>(response);

  if (!response.ok || !data.cloneId) {
    const errorMessage = typeof data.error === 'string' ? data.error : data.error?.message;
    throw new Error(errorMessage || 'Failed to start clone');
  }

  return data.cloneId;
};

const streamCloneProgress = (
  cloneId: string,
  handlers: CloneProgressHandlers,
) =>
  new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
    const eventSource = new EventSource(api.cloneProjectProgressUrl({ cloneId }));
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      eventSource.close();
      callback();
    };

    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as CloneProgressEvent;

        if (payload.type === 'progress' && payload.message) {
          handlers.onProgress(payload.message);
          return;
        }

        if (payload.type === 'complete') {
          settle(() => resolve(payload.project));
          return;
        }

        if (payload.type === 'error') {
          settle(() => reject(new Error(payload.message || 'Failed to clone repository')));
        }
      } catch (error) {
        console.error('Error parsing clone progress event:', error);
      }
    };

    eventSource.onerror = () => {
      settle(() => reject(new Error('Connection lost during clone')));
    };
  });

export const cloneWorkspaceWithProgress = async (
  params: CloneWorkspaceParams,
  handlers: CloneProgressHandlers,
) => streamCloneProgress(await startClone(params), handlers);
