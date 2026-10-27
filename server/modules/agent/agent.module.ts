import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';

import { Octokit } from '@octokit/rest';
import spawn from 'cross-spawn';

import {
  apiKeysDb,
  forgejoTokensDb,
  githubTokensDb,
  projectsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { createForgejoPullRequest, resolveRepositoryForge } from '@/modules/forges/index.js';
import { providerModelsService, sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { LLMProvider } from '@/shared/types.js';
import { IS_PLATFORM } from '@/shared/utils.js';

import { createAgentRouter } from './agent.routes.js';

type AgentExternalDependencies = Pick<
  Parameters<typeof createAgentRouter>[0],
  'queryClaude' | 'queryCursor' | 'queryCodex' | 'queryOpenCode'
>;

/**
 * Assembles the production Agent router while accepting provider runners from
 * the centralized provider runtime service.
 */
export function createAgentModule(externalDependencies: AgentExternalDependencies) {
  return createAgentRouter({
    fileSystem: fs,
    crypto,
    homeDirectory: os.homedir,
    spawnProcess: spawn,
    platformMode: IS_PLATFORM,
    users: {
      getFirstUser: () => userDb.getFirstUser(),
    },
    apiKeys: {
      validateApiKey: (apiKey) => apiKeysDb.validateApiKey(apiKey),
    },
    githubTokens: {
      getActiveGithubToken: (userId) => githubTokensDb.getActiveGithubToken(userId),
    },
    forgejoTokens: {
      getActiveForgejoToken: (userId, instanceUrl) => forgejoTokensDb.getActiveForgejoToken(userId, instanceUrl),
    },
    forges: {
      resolveRepositoryForge,
      createForgejoPullRequest: (input) => createForgejoPullRequest(input),
    },
    projects: {
      createProjectPath: (projectPath, customName) =>
        projectsDb.createProjectPath(projectPath, customName),
    },
    models: providerModelsService,
    sessions: {
      getSessionById: (sessionId) => sessionsDb.getSessionById(sessionId),
      getSessionByProviderSessionId: (providerSessionId) => sessionsDb.getSessionByProviderSessionId(providerSessionId),
      createAppSession: (provider, projectPath, initialMessage) =>
        sessionsService.createAppSession(provider as LLMProvider, projectPath, initialMessage),
    },
    runs: chatRunRegistry,
    GithubClient: Octokit,
    ...externalDependencies,
  });
}
