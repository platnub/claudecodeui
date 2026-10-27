// createForgesRouter: used by the server entrypoint to mount `/api/forges` (the project wizard's forge detection).
export { createForgesRouter } from './forges.routes.js';
// resolveRepositoryForge: used by the projects clone service and the agent module to tell GitHub from Forgejo.
export { resolveRepositoryForge } from './forge-detection.service.js';
export type { ResolvedRepositoryForge } from './forge-detection.service.js';
// getTokenCredentialOrigin / buildTokenCredentialEnvironment: used by the projects clone service and the agent module to hand git a token for one origin only.
export { buildTokenCredentialEnvironment, getTokenCredentialOrigin } from './git-credentials.service.js';
// createForgejoPullRequest / getBranchWebUrl: used by the agent module to open Forgejo pull requests and link pushed branches.
export { createForgejoPullRequest, getBranchWebUrl } from './forgejo-api.service.js';
// parseRepositoryUrl / getRepositoryWebUrl: used by the agent module to compare checkouts and name the repository a PR goes to,
// and by both the agent module and the projects clone service to refuse a link to a repository page and suggest the repository URL.
// normalizeForgejoInstanceUrl: used by the settings module to validate the instance URL of a Forgejo token.
export { getRepositoryWebUrl, normalizeForgejoInstanceUrl, parseRepositoryUrl } from './repository-url.service.js';
