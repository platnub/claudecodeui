import { isIP } from 'node:net';

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

/**
 * How many instance answers the probe cache holds. Every distinct host a user
 * types adds one, so the oldest is dropped past this.
 */
const PROBE_CACHE_MAX_ENTRIES = 256;

/** Whether a dotted IPv4 address is loopback, private, link-local, CGNAT or unspecified. */
function isNonPublicIpv4(address: string): boolean {
  const [first, second] = address.split('.').map(Number);
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

/**
 * Whether `host` names this machine or a private network: `localhost`, or an
 * IP literal in a loopback, private, link-local (cloud metadata) or
 * unspecified range. Such hosts are never probed, so the detect endpoint
 * cannot be pointed at internal services. The host goes through the URL
 * parser first, so `2130706433` or `0x7f.1` count as the 127.0.0.1 they are.
 * A DNS name is not resolved: a self-hosted instance on the LAN under a name
 * is still probed, and one reached by IP is recognised once the user stores a
 * token for it or picks Forgejo explicitly.
 */
function isNonPublicHost(host: string): boolean {
  let hostname: string;
  try {
    // IPv6 hosts arrive bracketed (`[::1]`), as the URL parser reports them.
    hostname = new URL(`https://${host}`).hostname;
  } catch {
    return true;
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return true;
  }

  const bareHostname = hostname.replace(/^\[|\]$/g, '');
  const ipVersion = isIP(bareHostname);
  if (ipVersion === 4) {
    return isNonPublicIpv4(bareHostname);
  }
  if (ipVersion === 6) {
    // IPv4-mapped (`::ffff:7f00:1`, as the parser writes it) is never a
    // forge's public address; refusing all of it covers every mapped range.
    return /^::ffff:/i.test(bareHostname)
      || bareHostname === '::'
      || bareHostname === '::1'
      || /^f[cd]/i.test(bareHostname)
      || /^fe[89ab]/i.test(bareHostname);
  }
  return false;
}

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
 * The request goes to the host the user typed, which only authenticated users
 * can do — but never to this machine or a private address
 * (`isNonPublicHost`), since detection runs while the user is still typing
 * and for ssh URLs, where the clone itself makes no HTTP request.
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
 * Forgejo token names its instance) hosts are Forgejo; localhost and private
 * IP addresses are not probed and resolve to null; anything else is probed
 * over the network once per instance and cached (the oldest of
 * `PROBE_CACHE_MAX_ENTRIES` answers is dropped first). Unrecognised hosts and
 * unparsable URLs resolve to null.
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
      if (isNonPublicHost(repository.host)) {
        return null;
      }

      const cached = probeCache.get(instanceUrl);
      if (cached && cached.expiresAt > now()) {
        return cached.isForgejo ? 'forgejo' : null;
      }

      const isForgejo = await probe(instanceUrl);
      // Re-inserting moves the entry to the end, so the first key is the oldest.
      probeCache.delete(instanceUrl);
      if (probeCache.size >= PROBE_CACHE_MAX_ENTRIES) {
        probeCache.delete(probeCache.keys().next().value as string);
      }
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
