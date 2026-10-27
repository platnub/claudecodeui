/**
 * Forgejo tokens repository.
 *
 * Helper layer over generic credentials storage. Tokens are stored in
 * `user_credentials` with `credential_type = 'forgejo_token'` and the
 * instance they were issued by in `service_url` (normalized by the forges
 * module: an https origin plus any sub-path, no trailing slash).
 */

import { getConnection } from '@/modules/database/connection.js';

const FORGEJO_TOKEN_TYPE = 'forgejo_token';

type ForgejoTokenLookup = {
  token: string;
  instanceUrl: string;
};

export const forgejoTokensDb = {
  /** Returns one active Forgejo token by id/user with its instance, or null. */
  getForgejoTokenById(userId: number, tokenId: number): ForgejoTokenLookup | null {
    const row = getConnection()
      .prepare(
        `SELECT credential_value, service_url
         FROM user_credentials
         WHERE id = ? AND user_id = ? AND credential_type = ? AND is_active = 1`
      )
      .get(tokenId, userId, FORGEJO_TOKEN_TYPE) as
      | { credential_value: string; service_url: string | null }
      | undefined;

    if (!row || !row.service_url) return null;
    return { token: row.credential_value, instanceUrl: row.service_url };
  },

  /** Returns the most recent active Forgejo token for one instance, or null. */
  getActiveForgejoToken(userId: number, instanceUrl: string): string | null {
    const row = getConnection()
      .prepare(
        `SELECT credential_value
         FROM user_credentials
         WHERE user_id = ? AND credential_type = ? AND service_url = ? AND is_active = 1
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(userId, FORGEJO_TOKEN_TYPE, instanceUrl) as { credential_value: string } | undefined;
    return row?.credential_value ?? null;
  },

  /**
   * Returns every instance URL the user holds an active Forgejo token for.
   * Forge detection treats these hosts as Forgejo without probing them.
   */
  getForgejoInstanceUrls(userId: number): string[] {
    const rows = getConnection()
      .prepare(
        `SELECT DISTINCT service_url
         FROM user_credentials
         WHERE user_id = ? AND credential_type = ? AND is_active = 1 AND service_url IS NOT NULL`
      )
      .all(userId, FORGEJO_TOKEN_TYPE) as { service_url: string }[];
    return rows.map((row) => row.service_url);
  },
};
