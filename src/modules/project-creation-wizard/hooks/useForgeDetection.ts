import { useEffect, useState } from 'react';

import { detectRepositoryForge } from '@/modules/project-creation-wizard/utils/workspaceApi';
import type { ForgeDetectionResult } from '@/shared/types';

/** How long the URL must stay unchanged before the server is asked about it. */
const DETECTION_DEBOUNCE_MS = 400;

const UNDETECTED: ForgeDetectionResult = { forge: null, instanceUrl: null };

/**
 * Asks the server which forge the repository URL lives on while the user
 * types, debounced, and keeps only the answer for the URL currently entered.
 */
export const useForgeDetection = (repositoryUrl: string, enabled: boolean) => {
  // The latest answer, tagged with the URL it is for so a stale answer is never shown.
  const [detection, setDetection] = useState<{ url: string; result: ForgeDetectionResult } | null>(null);
  const trimmedUrl = repositoryUrl.trim();

  useEffect(() => {
    if (!enabled || !trimmedUrl) {
      return;
    }

    let isDisposed = false;
    const timer = window.setTimeout(async () => {
      let result = UNDETECTED;
      try {
        result = await detectRepositoryForge(trimmedUrl);
      } catch {
        // An unreachable server reads as "host not recognised".
      }
      if (!isDisposed) {
        setDetection({ url: trimmedUrl, result });
      }
    }, DETECTION_DEBOUNCE_MS);

    return () => {
      isDisposed = true;
      window.clearTimeout(timer);
    };
  }, [enabled, trimmedUrl]);

  const hasAnswer = detection?.url === trimmedUrl;
  return {
    detected: hasAnswer ? detection.result : UNDETECTED,
    // Pending until an answer for exactly this URL has arrived.
    detecting: enabled && trimmedUrl.length > 0 && !hasAnswer,
  };
};
