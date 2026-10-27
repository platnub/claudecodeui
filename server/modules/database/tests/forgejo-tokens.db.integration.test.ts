import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  closeConnection,
  credentialsDb,
  forgejoTokensDb,
  getConnection,
  githubTokensDb,
  initializeDatabase,
} from '@/modules/database/index.js';

const USER_ID = 1;

async function withDatabase(
  runTest: () => void | Promise<void>,
  seedDatabase?: (databasePath: string) => void,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'forgejo-tokens-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  seedDatabase?.(databasePath);
  await initializeDatabase();

  getConnection()
    .prepare('INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ID, 'tester', 'hash');

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('Forgejo tokens are looked up per instance and kept apart from GitHub tokens', async () => {
  await withDatabase(() => {
    const github = credentialsDb.createCredential(USER_ID, 'GitHub', 'github_token', 'ghp_x');
    const codeberg = credentialsDb.createCredential(
      USER_ID, 'Codeberg', 'forgejo_token', 'cb_secret', null, 'https://codeberg.org',
    );
    credentialsDb.createCredential(
      USER_ID, 'Work', 'forgejo_token', 'work_secret', 'team', 'https://git.example.com',
    );

    assert.deepEqual(forgejoTokensDb.getForgejoTokenById(USER_ID, Number(codeberg.id)), {
      token: 'cb_secret',
      instanceUrl: 'https://codeberg.org',
    });
    assert.equal(forgejoTokensDb.getForgejoTokenById(USER_ID, Number(github.id)), null);
    assert.equal(githubTokensDb.getGithubTokenById(USER_ID, Number(codeberg.id)), null);
    assert.equal(forgejoTokensDb.getActiveForgejoToken(USER_ID, 'https://git.example.com'), 'work_secret');
    assert.equal(forgejoTokensDb.getActiveForgejoToken(USER_ID, 'https://other.example'), null);
    assert.deepEqual(
      forgejoTokensDb.getForgejoInstanceUrls(USER_ID).sort(),
      ['https://codeberg.org', 'https://git.example.com'],
    );

    credentialsDb.toggleCredential(USER_ID, Number(codeberg.id), false);
    assert.equal(forgejoTokensDb.getForgejoTokenById(USER_ID, Number(codeberg.id)), null);
    assert.deepEqual(forgejoTokensDb.getForgejoInstanceUrls(USER_ID), ['https://git.example.com']);

    const listed = credentialsDb.getCredentials(USER_ID, 'forgejo_token');
    assert.deepEqual(listed.map((row) => row.service_url).sort(), ['https://codeberg.org', 'https://git.example.com']);
    assert.ok(listed.every((row) => !('credential_value' in row)));
  });
});

test('the migration adds service_url to a credentials table created before it existed', async () => {
  await withDatabase(
    () => {
      const columns = getConnection().prepare('PRAGMA table_info(user_credentials)').all() as { name: string }[];
      assert.ok(columns.some((column) => column.name === 'service_url'));
      assert.deepEqual(
        credentialsDb.getCredentials(USER_ID, 'github_token').map((row) => [row.credential_name, row.service_url]),
        [['Old token', null]],
      );
    },
    (databasePath) => {
      const legacyDatabase = new Database(databasePath);
      legacyDatabase.exec(`
        CREATE TABLE user_credentials (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          credential_name TEXT NOT NULL,
          credential_type TEXT NOT NULL,
          credential_value TEXT NOT NULL,
          description TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          is_active BOOLEAN DEFAULT 1
        );
        INSERT INTO user_credentials (user_id, credential_name, credential_type, credential_value)
        VALUES (1, 'Old token', 'github_token', 'ghp_old');
      `);
      legacyDatabase.close();
    },
  );
});
