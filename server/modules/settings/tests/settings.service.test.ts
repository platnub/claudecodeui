import assert from 'node:assert/strict';
import test from 'node:test';

import { createSettingsService } from '../settings.service.js';

type Dependencies = Parameters<typeof createSettingsService>[0];

function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    apiKeys: { list: () => [], create: () => ({}), remove: () => false, toggle: () => false },
    credentials: { list: () => [], create: () => ({}), remove: () => false, toggle: () => false },
    notifications: {
      getPreferences: () => undefined,
      updatePreferences: () => ({}),
      createEnabledEvent: () => ({}),
      notifyUser: () => undefined,
    },
    pushSubscriptions: { save: () => undefined, remove: () => undefined },
    getVapidPublicKey: () => null,
    ...overrides,
  };
}

test('listApiKeys redacts secret values through the service boundary', () => {
  const service = createSettingsService(dependencies({
    apiKeys: {
      list: () => [{ id: 1, api_key: '1234567890-secret' }],
      create: () => ({}), remove: () => false, toggle: () => false,
    },
  }));
  assert.equal(service.listApiKeys(1).apiKeys[0]?.api_key, '1234567890...');
});

test('subscribeToPush persists the subscription and enables Web Push', () => {
  const operations: string[] = [];
  const service = createSettingsService(dependencies({
    pushSubscriptions: {
      save: (_id, endpoint) => operations.push(`save:${endpoint}`),
      remove: () => undefined,
    },
    notifications: {
      getPreferences: () => ({ channels: { webPush: false } }),
      updatePreferences: () => { operations.push('preferences'); return {}; },
      createEnabledEvent: () => ({ code: 'push.enabled' }),
      notifyUser: () => { operations.push('notify'); },
    },
  }));

  service.subscribeToPush(1, {
    endpoint: 'https://push.example.test',
    keys: { p256dh: 'key', auth: 'auth' },
  });
  assert.deepEqual(operations, ['save:https://push.example.test', 'preferences', 'notify']);
});

test('createCredential stores a Forgejo token with its normalized https instance', () => {
  const created: unknown[][] = [];
  const service = createSettingsService(dependencies({
    credentials: {
      list: () => [],
      create: (...args) => { created.push(args); return {}; },
      remove: () => false,
      toggle: () => false,
    },
  }));

  service.createCredential(1, {
    credentialName: 'Codeberg',
    credentialType: 'forgejo_token',
    credentialValue: 'secret',
    serviceUrl: 'codeberg.org/',
  });
  service.createCredential(1, {
    credentialName: 'GitHub',
    credentialType: 'github_token',
    credentialValue: 'ghp_secret',
    serviceUrl: 'https://ignored.example',
  });

  assert.deepEqual(created, [
    [1, 'Codeberg', 'forgejo_token', 'secret', null, 'https://codeberg.org'],
    [1, 'GitHub', 'github_token', 'ghp_secret', null, null],
  ]);
});

test('createCredential refuses a Forgejo token without an https instance URL', () => {
  const service = createSettingsService(dependencies());
  for (const serviceUrl of [undefined, '', 'http://git.example.com']) {
    assert.throws(
      () => service.createCredential(1, {
        credentialName: 'Forgejo',
        credentialType: 'forgejo_token',
        credentialValue: 'secret',
        serviceUrl,
      }),
      (error: { code?: string }) => error.code === 'CREDENTIAL_SERVICE_URL_INVALID',
    );
  }
});
