import { getRepositoryWebUrl } from '@/modules/forges/repository-url.service.js';
import type { GitForge, ParsedRepositoryUrl } from '@/shared/types.js';

/** How long one Forgejo API call may take. */
const FORGEJO_API_TIMEOUT_MS = 15000;

type ForgejoPullRequestInput = {
  /** The instance URL from `resolveForgejoInstanceUrl`, e.g. `https://codeberg.org`. */
  instanceUrl: string;
  repository: ParsedRepositoryUrl;
  token: string;
  head: string;
  base: string;
  title: string;
  body: string;
};

/**
 * Turns a failed Forgejo API response into an Error whose message carries
 * Forgejo's own explanation (`{"message": "..."}`) when it sent one.
 */
async function toForgejoApiError(response: Response): Promise<Error> {
  let detail = response.statusText;
  try {
    const payload = (await response.json()) as { message?: unknown };
    if (typeof payload?.message === 'string' && payload.message) {
      detail = payload.message;
    }
  } catch {
    // Not JSON: keep the status text.
  }
  return new Error(`Forgejo API error (${response.status}): ${detail}`);
}

/**
 * Opens a pull request on a Forgejo (or Gitea-compatible) instance through
 * `POST /api/v1/repos/{owner}/{repo}/pulls`, authenticated with an access
 * token that needs the `write:repository` scope.
 *
 * Used by the agent module, the Forgejo counterpart of its Octokit call.
 */
export async function createForgejoPullRequest(
  input: ForgejoPullRequestInput,
  fetchImplementation: typeof fetch = fetch,
): Promise<{ number: number; url: string }> {
  const { owner, repo } = input.repository;
  const response = await fetchImplementation(
    `${input.instanceUrl}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `token ${input.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        head: input.head,
        base: input.base,
        title: input.title,
        body: input.body,
      }),
      signal: AbortSignal.timeout(FORGEJO_API_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    throw await toForgejoApiError(response);
  }

  const pullRequest = (await response.json()) as { number: number; html_url: string };
  return { number: pullRequest.number, url: pullRequest.html_url };
}

/**
 * The web URL of a branch: GitHub's `/tree/<branch>` or Forgejo's
 * `/src/branch/<branch>`. Branch names keep their slashes; each segment is
 * percent-encoded.
 *
 * Used by the agent module to report the branch it pushed.
 */
export function getBranchWebUrl(
  forge: GitForge,
  repository: ParsedRepositoryUrl,
  branchName: string,
): string {
  const encodedBranch = branchName.split('/').map(encodeURIComponent).join('/');
  const routePrefix = forge === 'github' ? 'tree' : 'src/branch';
  return `${getRepositoryWebUrl(repository)}/${routePrefix}/${encodedBranch}`;
}
