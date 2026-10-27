import { access, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

// cross-spawn: drop-in spawn with Windows .cmd/PATHEXT resolution.
import spawn from 'cross-spawn';

import { forgejoTokensDb, githubTokensDb } from '@/modules/database/index.js';
import {
  buildTokenCredentialEnvironment,
  getTokenCredentialOrigin,
  resolveRepositoryForge,
  type ResolvedRepositoryForge,
} from '@/modules/forges/index.js';
import { createProject } from '@/modules/projects/services/project-management.service.js';
import type { GitForge, WorkspacePathValidationResult } from '@/shared/types.js';
import { AppError, validateWorkspacePath } from '@/shared/utils.js';

type CloneProjectInput = {
  workspacePath: string;
  repositoryUrl: string;
  /**
   * The forge the user picked for the repository. Null lets the URL decide; it
   * only matters when a token is used, to know which host may receive it.
   */
  forge?: GitForge | null;
  /** A stored GitHub or Forgejo token credential id. */
  tokenId?: number | null;
  /** A token typed in for this clone only. */
  newToken?: string | null;
  userId: number | string;
};

/** A stored token with what it is valid for: a forge, and for Forgejo one instance. */
type StoredForgeToken = {
  token: string;
  forge: GitForge;
  instanceUrl: string | null;
};

type CloneCompletePayload = {
  project: Record<string, unknown>;
  message: string;
};

type CloneProjectEventHandlers = {
  onProgress: (message: string) => void;
  onComplete: (payload: CloneCompletePayload) => void;
};

type GitCloneProcess = {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'close', listener: (code: number | null) => void): void;
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): void;
  kill(): void;
};

type CloneProjectDependencies = {
  validatePath: (requestedPath: string) => Promise<WorkspacePathValidationResult>;
  ensureDirectory: (directoryPath: string) => Promise<void>;
  pathExists: (targetPath: string) => Promise<boolean>;
  removePath: (targetPath: string) => Promise<void>;
  getStoredTokenById: (tokenId: number, userId: number) => Promise<StoredForgeToken | null>;
  resolveForge: (
    repositoryUrl: string,
    userId: number,
    forgeOverride: GitForge | null,
  ) => Promise<ResolvedRepositoryForge | null>;
  spawnGitClone: (
    cloneUrl: string,
    clonePath: string,
    environment: NodeJS.ProcessEnv,
  ) => GitCloneProcess;
  registerProject: (projectPath: string, customName: string) => Promise<{ project: Record<string, unknown> }>;
  logError: (message: string, error: unknown) => void;
};

export type CloneProjectOperation = {
  waitForCompletion: Promise<void>;
  cancel: () => void;
};

async function defaultPathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

function resolveCloneFailureMessage(lastError: string): string {
  if (lastError.includes('Authentication failed') || lastError.includes('could not read Username')) {
    return 'Authentication failed. Please check your credentials.';
  }

  if (lastError.includes('Repository not found')) {
    return 'Repository not found. Please check the URL and ensure you have access.';
  }

  if (lastError.includes('already exists')) {
    return 'Directory already exists';
  }

  return lastError || 'Git clone failed';
}

function resolveErrorMessage(error: unknown): string {
  if (error instanceof AppError) {
    return error.message;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Unexpected error';
}

const defaultDependencies: CloneProjectDependencies = {
  validatePath: validateWorkspacePath,
  ensureDirectory: async (directoryPath: string): Promise<void> => {
    await mkdir(directoryPath, { recursive: true });
  },
  pathExists: defaultPathExists,
  removePath: async (targetPath: string): Promise<void> => {
    await rm(targetPath, { recursive: true, force: true });
  },
  getStoredTokenById: async (tokenId: number, userId: number): Promise<StoredForgeToken | null> => {
    const githubToken = githubTokensDb.getGithubTokenById(userId, tokenId);
    if (githubToken) {
      return { token: githubToken.github_token, forge: 'github', instanceUrl: null };
    }
    const forgejoToken = forgejoTokensDb.getForgejoTokenById(userId, tokenId);
    if (forgejoToken) {
      return { token: forgejoToken.token, forge: 'forgejo', instanceUrl: forgejoToken.instanceUrl };
    }
    return null;
  },
  resolveForge: resolveRepositoryForge,
  spawnGitClone: (
    cloneUrl: string,
    clonePath: string,
    environment: NodeJS.ProcessEnv,
  ): GitCloneProcess =>
    spawn('git', ['clone', '--progress', '--', cloneUrl, clonePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: environment,
    }) as unknown as GitCloneProcess,
  registerProject: async (
    projectPath: string,
    customName: string,
  ): Promise<{ project: Record<string, unknown> }> =>
    createProject({
      projectPath,
      customName,
    }) as Promise<{ project: Record<string, unknown> }>,
  logError: (message: string, error: unknown): void => {
    console.error(message, error);
  },
};

/**
 * Whether a clone URL embeds a credential: any password, or a username on an
 * http(s) URL. An SSH URL's `git@` is a login name, not a secret.
 */
function carriesCredentials(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // scp-like `git@github.com:org/repo.git` and bare paths are not URLs;
    // an scp-like user is an SSH login, which is not a credential.
    return false;
  }
  if (parsed.password) {
    return true;
  }
  return Boolean(parsed.username) && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
}

function isParsableUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function requireNumericUserId(userId: number | string): number {
  const numericUserId = typeof userId === 'number' ? userId : Number.parseInt(String(userId), 10);
  if (Number.isNaN(numericUserId)) {
    throw new AppError('Authenticated user is required', {
      code: 'AUTHENTICATION_REQUIRED',
      statusCode: 401,
    });
  }
  return numericUserId;
}

/**
 * Builds the environment the clone runs in. Without a token git runs with
 * prompts disabled and whatever access the machine has (public repos, SSH
 * keys). With one, the forge decides which single https origin the token is
 * offered to (see `buildTokenCredentialEnvironment`): github.com for a GitHub
 * token, the repository's own instance for a Forgejo token. A stored token
 * carries its forge; a typed one takes the forge the user picked, or the one
 * detected from the URL.
 */
async function resolveCloneEnvironment(
  input: CloneProjectInput,
  repositoryUrl: string,
  dependencies: CloneProjectDependencies,
): Promise<NodeJS.ProcessEnv> {
  let storedToken: StoredForgeToken | null = null;
  let token: string | null = null;
  if (typeof input.tokenId === 'number') {
    storedToken = await dependencies.getStoredTokenById(input.tokenId, requireNumericUserId(input.userId));
    if (!storedToken) {
      throw new AppError('Token not found', {
        code: 'FORGE_TOKEN_NOT_FOUND',
        statusCode: 404,
      });
    }
    token = storedToken.token;
  } else if (input.newToken && input.newToken.trim().length > 0) {
    token = input.newToken.trim();
  }

  if (!token) {
    return { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  }

  const resolved = await dependencies.resolveForge(
    repositoryUrl,
    requireNumericUserId(input.userId),
    storedToken?.forge ?? input.forge ?? null,
  );
  if (!resolved?.forge) {
    throw new AppError(
      'Could not tell whether this repository is hosted on GitHub or Forgejo. Choose the host, or clone without a token.',
      { code: 'FORGE_UNDETECTED', statusCode: 400 },
    );
  }

  if (storedToken?.instanceUrl && resolved.instanceUrl !== storedToken.instanceUrl) {
    throw new AppError(
      `This token belongs to ${storedToken.instanceUrl}, but the repository is on ${resolved.instanceUrl ?? resolved.repository.webOrigin}.`,
      { code: 'FORGE_TOKEN_INSTANCE_MISMATCH', statusCode: 400 },
    );
  }

  const credentialOrigin = getTokenCredentialOrigin(resolved.forge, resolved.repository);
  if (!credentialOrigin) {
    throw new AppError('A Forgejo token is only sent over https. Use an https URL, or clone without a token.', {
      code: 'FORGE_TOKEN_REQUIRES_HTTPS',
      statusCode: 400,
    });
  }

  return buildTokenCredentialEnvironment(token, credentialOrigin);
}

export async function startCloneProject(
  input: CloneProjectInput,
  handlers: CloneProjectEventHandlers,
  dependencyOverrides: Partial<CloneProjectDependencies> = {},
): Promise<CloneProjectOperation> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const normalizedWorkspacePath = input.workspacePath.trim();
  const normalizedRepositoryUrl = input.repositoryUrl.trim();

  if (!normalizedWorkspacePath) {
    throw new AppError('workspacePath and repositoryUrl are required', {
      code: 'WORKSPACE_PATH_REQUIRED',
      statusCode: 400,
    });
  }

  if (!normalizedRepositoryUrl) {
    throw new AppError('workspacePath and repositoryUrl are required', {
      code: 'REPOSITORY_URL_REQUIRED',
      statusCode: 400,
    });
  }

  if (normalizedRepositoryUrl.startsWith('-')) {
    throw new AppError('Invalid repositoryUrl', {
      code: 'INVALID_REPOSITORY_URL',
      statusCode: 400,
    });
  }

  // An http(s) string the URL parser rejects (a bad port, a space in the
  // host) is one curl rejects too — but only after git has carried it, and
  // any credential in it, on its command line.
  if (/^https?:/i.test(normalizedRepositoryUrl) && !isParsableUrl(normalizedRepositoryUrl)) {
    throw new AppError('Invalid repositoryUrl', {
      code: 'INVALID_REPOSITORY_URL',
      statusCode: 400,
    });
  }

  if (carriesCredentials(normalizedRepositoryUrl)) {
    // The token field is the only way in: a credential in the URL would ride
    // git's argv, its stderr and the clone's `.git/config`.
    throw new AppError('Put the token in the token field, not in the URL', {
      code: 'REPOSITORY_URL_CARRIES_CREDENTIALS',
      statusCode: 400,
    });
  }

  const pathValidation = await dependencies.validatePath(normalizedWorkspacePath);
  if (!pathValidation.valid || !pathValidation.resolvedPath) {
    throw new AppError(pathValidation.error || 'Invalid workspace path', {
      code: 'INVALID_PROJECT_PATH',
      statusCode: 400,
    });
  }

  const absolutePath = pathValidation.resolvedPath;
  await dependencies.ensureDirectory(absolutePath);

  const cloneEnvironment = await resolveCloneEnvironment(input, normalizedRepositoryUrl, dependencies);

  const sanitizedRepositoryUrl = normalizedRepositoryUrl.replace(/\/+$/, '').replace(/\.git$/, '');
  const repoName = sanitizedRepositoryUrl.split('/').pop() || 'repository';
  const clonePath = path.join(absolutePath, repoName);

  if (await dependencies.pathExists(clonePath)) {
    throw new AppError(
      `Directory "${repoName}" already exists. Please choose a different location or remove the existing directory.`,
      {
        code: 'CLONE_TARGET_ALREADY_EXISTS',
        statusCode: 409,
      },
    );
  }

  handlers.onProgress(`Cloning into '${repoName}'...`);
  const gitProcess = dependencies.spawnGitClone(
    normalizedRepositoryUrl,
    clonePath,
    cloneEnvironment,
  );
  let lastError = '';

  // `git clone --progress` writes every byte of its progress to stderr. Git
  // was handed a credential-free URL, so each chunk is forwarded as it arrives.
  gitProcess.stdout?.on('data', (data: Buffer | string) => {
    const message = data.toString().trim();
    if (message) {
      handlers.onProgress(message);
    }
  });

  gitProcess.stderr?.on('data', (data: Buffer | string) => {
    const message = data.toString().trim();
    if (message) {
      lastError = message;
      handlers.onProgress(message);
    }
  });

  const waitForCompletion = new Promise<void>((resolve, reject) => {
    gitProcess.on('close', async (code) => {
      if (code === 0) {
        try {
          const createdProject = await dependencies.registerProject(clonePath, repoName);
          handlers.onComplete({
            project: createdProject.project,
            message: 'Repository cloned successfully',
          });
          resolve();
        } catch (error) {
          reject(
            new AppError(`Clone succeeded but failed to add project: ${resolveErrorMessage(error)}`, {
              code: 'CLONE_PROJECT_REGISTRATION_FAILED',
              statusCode: 500,
            }),
          );
        }
        return;
      }

      const errorMessage = resolveCloneFailureMessage(lastError);

      try {
        await dependencies.removePath(clonePath);
      } catch (cleanupError) {
        dependencies.logError('Failed to clean up after clone failure:', cleanupError);
      }

      reject(
        new AppError(errorMessage, {
          code: 'GIT_CLONE_FAILED',
          statusCode: 500,
        }),
      );
    });

    gitProcess.on('error', (error) => {
      if (error.code === 'ENOENT') {
        reject(
          new AppError('Git is not installed or not in PATH', {
            code: 'GIT_NOT_FOUND',
            statusCode: 500,
          }),
        );
        return;
      }

      reject(
        new AppError(error.message, {
          code: 'GIT_EXECUTION_FAILED',
          statusCode: 500,
        }),
      );
    });
  });

  return {
    waitForCompletion,
    cancel: () => {
      gitProcess.kill();
    },
  };
}
