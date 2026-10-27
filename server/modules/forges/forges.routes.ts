import express from 'express';

import { resolveRepositoryForge } from '@/modules/forges/forge-detection.service.js';
import { asyncHandler, requireAuthenticatedUserId } from '@/shared/utils.js';

/**
 * Forge routes, mounted at `/api/forges` by the server entrypoint.
 *
 * `GET /detect?url=` answers which forge a repository URL lives on, so the
 * project wizard can offer the matching tokens. `forge` is null for hosts that
 * are neither GitHub nor Forgejo, and `instanceUrl` is set for Forgejo.
 */
export function createForgesRouter(): express.Router {
  const router = express.Router();

  router.get(
    '/detect',
    asyncHandler(async (req, res) => {
      const userId = requireAuthenticatedUserId(req);
      const repositoryUrl = typeof req.query.url === 'string' ? req.query.url : '';
      const resolved = await resolveRepositoryForge(repositoryUrl, userId);
      res.json({
        forge: resolved?.forge ?? null,
        instanceUrl: resolved?.instanceUrl ?? null,
      });
    }),
  );

  return router;
}
