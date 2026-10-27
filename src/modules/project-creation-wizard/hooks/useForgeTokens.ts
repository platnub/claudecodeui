import { useEffect, useMemo, useRef, useState } from 'react';

import { getHttpsOrigin } from '@/modules/project-creation-wizard/utils/pathUtils';
import {
  fetchForgeTokenCredentials,
  isCredentialForForge,
} from '@/modules/project-creation-wizard/utils/workspaceApi';
import type { ForgeTokenCredential, GitForge } from '@/shared/types';

type UseForgeTokensParams = {
  shouldLoad: boolean;
  forge: GitForge | null;
  repositoryUrl: string;
  /** The Forgejo instance the server matched the URL to, when it did. */
  instanceUrl: string | null;
  selectedTokenId: string;
  onAutoSelectToken: (tokenId: string) => void;
};

/** Whether a stored Forgejo token was issued by the instance the repository lives on. */
const belongsToInstance = (
  credential: ForgeTokenCredential,
  repositoryUrl: string,
  instanceUrl: string | null,
) => {
  if (!credential.service_url) {
    return false;
  }
  if (instanceUrl) {
    return credential.service_url === instanceUrl;
  }
  const repositoryOrigin = getHttpsOrigin(repositoryUrl);
  return repositoryOrigin !== null && getHttpsOrigin(credential.service_url) === repositoryOrigin;
};

/**
 * Loads the user's stored GitHub and Forgejo tokens once, and offers only the
 * ones that can authenticate the current repository: GitHub tokens for GitHub,
 * Forgejo tokens of the matching instance for Forgejo, none for an unknown host.
 * Keeps the selection valid as the URL or forge changes.
 */
export const useForgeTokens = ({
  shouldLoad,
  forge,
  repositoryUrl,
  instanceUrl,
  selectedTokenId,
  onAutoSelectToken,
}: UseForgeTokensParams) => {
  // Every active stored forge token; fetched once, filtered per repository below.
  const [allTokens, setAllTokens] = useState<ForgeTokenCredential[]>([]);
  // True while the stored tokens are being fetched, so the card can show a spinner.
  const [loading, setLoading] = useState(false);
  // The fetch failure to show in the authentication card.
  const [loadError, setLoadError] = useState<string | null>(null);
  // Set once the tokens arrived, so the selection is only corrected against a real list.
  const [hasLoaded, setHasLoaded] = useState(false);
  const isLoadingRef = useRef(false);

  useEffect(() => {
    if (!shouldLoad || hasLoaded || isLoadingRef.current) {
      return;
    }

    let isDisposed = false;
    isLoadingRef.current = true;

    const loadTokens = async () => {
      setLoading(true);
      setLoadError(null);

      try {
        const activeTokens = await fetchForgeTokenCredentials();
        if (!isDisposed) {
          setAllTokens(activeTokens);
          setHasLoaded(true);
        }
      } catch (error) {
        if (!isDisposed) {
          setLoadError(error instanceof Error ? error.message : 'Failed to load stored tokens');
        }
      } finally {
        isLoadingRef.current = false;
        if (!isDisposed) {
          setLoading(false);
        }
      }
    };

    loadTokens();

    return () => {
      isDisposed = true;
    };
  }, [hasLoaded, shouldLoad]);

  const tokens = useMemo(() => {
    if (!forge) {
      return [];
    }
    return allTokens.filter((credential) =>
      isCredentialForForge(credential, forge)
      && (forge === 'github' || belongsToInstance(credential, repositoryUrl, instanceUrl)));
  }, [allTokens, forge, instanceUrl, repositoryUrl]);

  // A token picked for one host must not stay selected for another.
  useEffect(() => {
    if (!hasLoaded) {
      return;
    }
    const selectionIsAvailable = tokens.some((token) => String(token.id) === selectedTokenId);
    const nextTokenId = selectionIsAvailable
      ? selectedTokenId
      : tokens.length > 0 ? String(tokens[0].id) : '';
    if (nextTokenId !== selectedTokenId) {
      onAutoSelectToken(nextTokenId);
    }
  }, [hasLoaded, onAutoSelectToken, selectedTokenId, tokens]);

  const selectedTokenName = useMemo(
    () => tokens.find((token) => String(token.id) === selectedTokenId)?.credential_name || null,
    [selectedTokenId, tokens],
  );

  return {
    tokens,
    loading,
    loadError,
    selectedTokenName,
  };
};
