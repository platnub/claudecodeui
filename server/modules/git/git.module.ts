import * as fs from 'node:fs/promises';

import spawn from 'cross-spawn';

import { projectsDb } from '@/modules/database/index.js';
import { buildRemoteCredentialEnvironment } from '@/modules/forges/index.js';

import { createGitRouter } from './git.routes.js';

type GitExternalDependencies = Pick<
  Parameters<typeof createGitRouter>[0],
  'queryClaude' | 'queryCursor'
>;

/** Assembles the Git router with runners from the centralized provider runtime service. */
export function createGitModule(externalDependencies: GitExternalDependencies) {
  return createGitRouter({
    fileSystem: fs,
    spawnProcess: spawn,
    resolveProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
    resolveRemoteEnvironment: (remoteUrl, userId) => buildRemoteCredentialEnvironment(remoteUrl, userId),
    ...externalDependencies,
  });
}
