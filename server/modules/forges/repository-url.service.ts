import type { ParsedRepositoryUrl } from '@/shared/types.js';

/** A URL with a scheme (`https://`, `ssh://`, ...), as opposed to scp-like `git@host:path`. */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * scp-like ssh syntax: `[user@]host:path`. The path must not start with `/`
 * after the colon (that would be `host:/abs`, still scp-like, but also how a
 * Windows drive path `C:/x` looks — those have a one-letter host and fail the
 * owner/repo check below anyway).
 */
const SCP_LIKE_PATTERN = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/;

/**
 * Parses a git remote URL into forge-relevant parts, or returns null for
 * anything that is not a recognisable `owner/repo` remote (a bare path, a
 * file:// URL, a URL with only one path segment).
 *
 * Used by forge detection and Forgejo API calls in this module, by the
 * projects module's clone service to scope a token to the repository's host,
 * and by the agent module to find where to open a pull request.
 */
export function parseRepositoryUrl(url: string): ParsedRepositoryUrl | null {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) {
    return null;
  }

  let transport: ParsedRepositoryUrl['transport'];
  let host: string;
  let webOrigin: string;
  let pathName: string;

  if (!SCHEME_PATTERN.test(trimmedUrl)) {
    const scpMatch = SCP_LIKE_PATTERN.exec(trimmedUrl);
    if (!scpMatch) {
      return null;
    }
    transport = 'ssh';
    host = scpMatch[1].toLowerCase();
    webOrigin = `https://${host}`;
    pathName = scpMatch[2];
  } else {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmedUrl);
    } catch {
      return null;
    }

    if (parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'http:') {
      transport = parsedUrl.protocol === 'https:' ? 'https' : 'http';
      webOrigin = parsedUrl.origin.toLowerCase();
    } else if (parsedUrl.protocol === 'ssh:' || parsedUrl.protocol === 'git+ssh:') {
      transport = 'ssh';
      webOrigin = `https://${parsedUrl.hostname.toLowerCase()}`;
    } else {
      return null;
    }
    host = parsedUrl.hostname.toLowerCase();
    pathName = decodeURIComponent(parsedUrl.pathname);
  }

  const segments = pathName
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean);
  if (!host || segments.length < 2) {
    return null;
  }

  const repo = segments[segments.length - 1];
  const owner = segments[segments.length - 2];
  // An ssh path is relative to the git user's home, never a web sub-path.
  const basePath = transport === 'ssh' || segments.length === 2
    ? ''
    : `/${segments.slice(0, -2).join('/')}`;

  return { transport, host, webOrigin, basePath, owner, repo };
}

/**
 * The repository's page in the forge's web UI, e.g.
 * `https://codeberg.org/owner/repo`. Used by the agent module to build branch
 * links, and to compare a checkout's remote with a requested clone URL.
 */
export function getRepositoryWebUrl(repository: ParsedRepositoryUrl): string {
  return `${repository.webOrigin}${repository.basePath}/${repository.owner}/${repository.repo}`;
}

/**
 * Normalises a Forgejo instance URL the user typed (`codeberg.org`,
 * `https://git.example.com/`, `https://example.com/forgejo`) to the form stored
 * with a Forgejo token and compared against repository URLs: an https origin
 * plus any sub-path, without a trailing slash.
 *
 * Returns null for anything that is not an https URL without credentials:
 * a token stored for an http instance would be sent in the clear.
 *
 * Used by the settings module to validate a Forgejo credential before storing
 * it, and by this module to match repositories to stored instances.
 */
export function normalizeForgejoInstanceUrl(instanceUrl: string): string | null {
  const trimmedUrl = instanceUrl.trim();
  if (!trimmedUrl) {
    return null;
  }

  const withScheme = SCHEME_PATTERN.test(trimmedUrl) ? trimmedUrl : `https://${trimmedUrl}`;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(withScheme);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) {
    return null;
  }

  const pathName = parsedUrl.pathname.replace(/\/+$/, '');
  return `${parsedUrl.origin.toLowerCase()}${pathName}`;
}

/**
 * The Forgejo instance a repository belongs to: the stored instance URL that
 * matches it when there is one (so an ssh remote of a sub-path install still
 * reaches the right API), otherwise the repository's own origin and sub-path.
 *
 * Used by forge detection here and by the agent and projects modules to pick
 * the matching stored Forgejo token and the API base.
 */
export function resolveForgejoInstanceUrl(
  repository: ParsedRepositoryUrl,
  knownInstanceUrls: readonly string[] = [],
): string {
  const ownInstanceUrl = `${repository.webOrigin}${repository.basePath}`;
  for (const knownInstanceUrl of knownInstanceUrls) {
    const normalizedKnownUrl = normalizeForgejoInstanceUrl(knownInstanceUrl);
    if (!normalizedKnownUrl) {
      continue;
    }
    if (normalizedKnownUrl === ownInstanceUrl) {
      return normalizedKnownUrl;
    }
    // An ssh remote carries no web sub-path; the host alone identifies it.
    if (repository.transport === 'ssh' && new URL(normalizedKnownUrl).hostname === repository.host) {
      return normalizedKnownUrl;
    }
  }
  return ownInstanceUrl;
}
