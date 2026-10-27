import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, credentialsDb, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { buildRemoteCredentialEnvironment } from '@/modules/forges/git-credentials.service.js';

const USER_ID = 1;
const OTHER_USER_ID = 2;
const BASE_ENVIRONMENT = { PATH: '/usr/bin' };

/** Runs `runTest` against a fresh database holding one Forgejo token for git.example.com. */
async function withForgejoToken(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'remote-credentials-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  await initializeDatabase();
  const insertUser = getConnection().prepare('INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, ?)');
  insertUser.run(USER_ID, 'tester', 'hash');
  insertUser.run(OTHER_USER_ID, 'other', 'hash');
  credentialsDb.createCredential(USER_ID, 'Work', 'forgejo_token', 'work_secret', null, 'https://git.example.com');

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

test('buildRemoteCredentialEnvironment offers the stored Forgejo token to that instance only', async () => {
  await withForgejoToken(() => {
    const environment = buildRemoteCredentialEnvironment('https://git.example.com/team/repo.git', USER_ID, BASE_ENVIRONMENT);
    assert.equal(environment.CLOUDCLI_GIT_TOKEN, 'work_secret');
    assert.equal(environment.GIT_CONFIG_KEY_1, 'credential.https://git.example.com.helper');
    assert.equal(environment.GIT_TERMINAL_PROMPT, '0');
    assert.equal(environment.PATH, '/usr/bin');
  });
});

test('buildRemoteCredentialEnvironment leaves other remotes on the machine credentials, prompts off', async () => {
  await withForgejoToken(() => {
    for (const [remoteUrl, userId] of [
      ['https://github.com/team/repo.git', USER_ID],
      ['https://codeberg.org/team/repo.git', USER_ID],
      // ssh authenticates with keys; the token is never sent there.
      ['git@git.example.com:team/repo.git', USER_ID],
      ['/srv/git/repo.git', USER_ID],
      // Another user's token is never used.
      ['https://git.example.com/team/repo.git', OTHER_USER_ID],
    ] as const) {
      const environment = buildRemoteCredentialEnvironment(remoteUrl, userId, BASE_ENVIRONMENT);
      assert.deepEqual(environment, { PATH: '/usr/bin', GIT_TERMINAL_PROMPT: '0' }, remoteUrl);
    }
  });
});
