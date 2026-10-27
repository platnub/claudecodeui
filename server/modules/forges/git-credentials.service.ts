import { forgejoTokensDb } from '@/modules/database/index.js';
import { parseRepositoryUrl, resolveForgejoInstanceUrl } from '@/modules/forges/repository-url.service.js';
import type { GitForge, ParsedRepositoryUrl } from '@/shared/types.js';

/** The only origin a GitHub token is ever offered to. */
const GITHUB_CREDENTIAL_ORIGIN = 'https://github.com';

/**
 * The https origin a forge token may be offered to when git clones or pushes
 * `repository`. A GitHub token only ever goes to github.com — whatever host the
 * URL names, so a GitHub token paired with another host is simply never
 * offered. A Forgejo token goes to the repository's own origin, and only over
 * https: null means the token must not be used at all.
 *
 * Used by the projects module's clone service and the agent module.
 */
export function getTokenCredentialOrigin(
  forge: GitForge,
  repository: ParsedRepositoryUrl,
): string | null {
  if (forge === 'github') {
    return GITHUB_CREDENTIAL_ORIGIN;
  }
  return repository.transport === 'https' ? repository.webOrigin : null;
}

/**
 * Builds the environment a git subprocess runs in so that it authenticates to
 * exactly one https origin with `token`.
 *
 * The token never goes into a clone URL: git echoes that URL on stderr, it
 * sits in the process argv (readable through /proc), and it is written to the
 * repository's `.git/config` as the remote. Instead env-only config points git
 * at a credential helper that reads the token from its own environment. The
 * empty first helper entry clears any helper configured on the machine so a
 * credential stored there cannot shadow the one the user chose; the helper
 * itself is scoped to `credentialOrigin`, so a redirect or a submodule on any
 * other host gets no credential.
 *
 * `x-access-token` is the username GitHub expects for a token; Forgejo ignores
 * the username when the password is an access token.
 *
 * Used by the projects module's clone service and the agent module.
 */
export function buildTokenCredentialEnvironment(
  token: string,
  credentialOrigin: string,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...baseEnvironment,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: `credential.${credentialOrigin}.helper`,
    GIT_CONFIG_VALUE_1: '!f() { echo username=x-access-token; echo "password=$CLOUDCLI_GIT_TOKEN"; }; f',
    CLOUDCLI_GIT_TOKEN: token,
    GIT_TERMINAL_PROMPT: '0',
  };
}

/**
 * The environment a git network command (fetch, pull, push) on an existing
 * checkout runs in for one user, given the URL of the remote it talks to.
 *
 * When the remote is an https repository on a Forgejo instance the user stored
 * a token for, the token is offered to that origin only (see
 * `buildTokenCredentialEnvironment`). Anything else — GitHub, ssh remotes,
 * hosts without a stored token — keeps the machine's own credentials (a `gh`
 * helper, SSH keys) as before. GitHub tokens are not injected here: they
 * would shadow a helper such as `gh auth git-credential` the user relies on.
 * Prompts are always disabled, so a missing credential fails at once instead
 * of git waiting on the server's terminal.
 *
 * Used by the git module's Source Control fetch, pull, push and publish routes.
 */
export function buildRemoteCredentialEnvironment(
  remoteUrl: string,
  userId: number,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const promptlessEnvironment = { ...baseEnvironment, GIT_TERMINAL_PROMPT: '0' };
  const repository = parseRepositoryUrl(remoteUrl);
  if (!repository || repository.transport !== 'https') {
    return promptlessEnvironment;
  }

  const knownInstanceUrls = forgejoTokensDb.getForgejoInstanceUrls(userId);
  const instanceUrl = resolveForgejoInstanceUrl(repository, knownInstanceUrls);
  if (!knownInstanceUrls.includes(instanceUrl)) {
    return promptlessEnvironment;
  }

  const token = forgejoTokensDb.getActiveForgejoToken(userId, instanceUrl);
  const credentialOrigin = getTokenCredentialOrigin('forgejo', repository);
  if (!token || !credentialOrigin) {
    return promptlessEnvironment;
  }
  return buildTokenCredentialEnvironment(token, credentialOrigin, baseEnvironment);
}
