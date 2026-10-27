import { forgejoTokensDb } from '@/modules/database/index.js';
import {
  normalizeForgejoInstanceUrl,
  parseRepositoryUrl,
  resolveForgejoInstanceUrl,
} from '@/modules/forges/repository-url.service.js';
import type { GitForge, ParsedRepositoryUrl } from '@/shared/types.js';

/** github.com itself; GitHub Enterprise Server is not supported. */
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);

/** Public Forgejo instances recognised without a network probe. */
const WELL_KNOWN_FORGEJO_HOSTS = new Set(['codeberg.org']);

/** How long a probe answer for an instance is reused, either way. */
const PROBE_CACHE_TTL_MS = 10 * 60 * 1000;

/** How long one probe request may take before the host counts as "not Forgejo". */
const PROBE_TIMEOUT_MS = 4000;

/** Asks an instance URL whether it is Forgejo; resolves false on any failure. */
type ForgejoProbe = (instanceUrl: string) => Promise<boolean>;

type ForgeDetector = {
  detect(repositoryUrl: string, knownForgejoInstanceUrls?: readonly string[]): Promise<GitForge | null>;
};

/**
 * Whether `${instanceUrl}${apiPath}` answers like a Forgejo/Gitea version
 * endpoint: `200` with a JSON body carrying a string `version`. GitHub and
 * other hosts answer 404 or HTML.
 */
async function answersVersionEndpoint(instanceUrl: string, apiPath: string): Promise<boolean> {
  try {
    const response = await fetch(`${instanceUrl}${apiPath}`, {
      headers: { Accept: 'application/json' },
      // A redirect to some other host is not this host answering.
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as { version?: unknown };
    return typeof body?.version === 'string';
  } catch {
    return false;
  }
}

/**
 * The default probe. `/api/forgejo/v1/version` exists only on Forgejo;
 * `/api/v1/version` is the older endpoint Forgejo shares with Gitea, whose
 * pull-request API is the same, so either answer means "Forgejo-compatible".
 *
 * The request goes to whatever host the user typed. That is no more than the
 * clone that follows does, and only authenticated users can trigger it.
 */
async function probeForgejoInstance(instanceUrl: string): Promise<boolean> {
  if (await answersVersionEndpoint(instanceUrl, '/api/forgejo/v1/version')) {
    return true;
  }
  return answersVersionEndpoint(instanceUrl, '/api/v1/version');
}

/**
 * Creates a detector that tells which forge a repository URL lives on.
 *
 * Order: github.com is GitHub; well-known and user-configured (a stored
 * Forgejo token names its instance) hosts are Forgejo; anything else is
 * probed over the network once per instance and cached. Unrecognised hosts
 * and unparsable URLs resolve to null.
 *
 * Exported for this module's tests, which inject a probe.
 */
export function createForgeDetector(
  probe: ForgejoProbe = probeForgejoInstance,
  now: () => number = Date.now,
): ForgeDetector {
  const probeCache = new Map<string, { isForgejo: boolean; expiresAt: number }>();

  return {
    async detect(repositoryUrl, knownForgejoInstanceUrls = []) {
      const repository = parseRepositoryUrl(repositoryUrl);
      if (!repository) {
        return null;
      }

      if (GITHUB_HOSTS.has(repository.host)) {
        return 'github';
      }
      if (WELL_KNOWN_FORGEJO_HOSTS.has(repository.host)) {
        return 'forgejo';
      }

      const normalizedKnownUrls = knownForgejoInstanceUrls
        .map((knownUrl) => normalizeForgejoInstanceUrl(knownUrl))
        .filter((knownUrl): knownUrl is string => Boolean(knownUrl));
      const instanceUrl = resolveForgejoInstanceUrl(repository, normalizedKnownUrls);
      if (normalizedKnownUrls.includes(instanceUrl)) {
        return 'forgejo';
      }

      const cached = probeCache.get(instanceUrl);
      if (cached && cached.expiresAt > now()) {
        return cached.isForgejo ? 'forgejo' : null;
      }

      const isForgejo = await probe(instanceUrl);
      probeCache.set(instanceUrl, { isForgejo, expiresAt: now() + PROBE_CACHE_TTL_MS });
      return isForgejo ? 'forgejo' : null;
    },
  };
}

/**
 * The process-wide detector. Used by the forges routes (the project wizard's
 * live detection), the projects module's clone service and the agent module,
 * so all three share one probe cache.
 */
export const forgeDetector = createForgeDetector();

/**
 * Which forge a repository lives on, for one user, plus what the caller needs
 * to talk to it. `instanceUrl` is the Forgejo instance (matched against the
 * user's stored instances first) and null for GitHub or an unknown host.
 */
export type ResolvedRepositoryForge = {
  repository: ParsedRepositoryUrl;
  forge: GitForge | null;
  instanceUrl: string | null;
};

/**
 * Resolves the forge of `repositoryUrl` for one user. The instances the user
 * stored Forgejo tokens for count as known Forgejo hosts, so they are never
 * probed. `forgeOverride`, when the user picked a forge explicitly, replaces
 * detection. Returns null for a URL that is not an `owner/repo` remote.
 *
 * Used by the forges routes (the project wizard), the projects module's clone
 * service and the agent module: the one entry point that knows about stored
 * instances.
 */
export async function resolveRepositoryForge(
  repositoryUrl: string,
  userId: number,
  forgeOverride: GitForge | null = null,
): Promise<ResolvedRepositoryForge | null> {
  const repository = parseRepositoryUrl(repositoryUrl);
  if (!repository) {
    return null;
  }

  const knownInstanceUrls = forgejoTokensDb.getForgejoInstanceUrls(userId);
  const forge = forgeOverride ?? await forgeDetector.detect(repositoryUrl, knownInstanceUrls);
  return {
    repository,
    forge,
    instanceUrl: forge === 'forgejo' ? resolveForgejoInstanceUrl(repository, knownInstanceUrls) : null,
  };
}
