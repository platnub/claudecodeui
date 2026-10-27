import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import {
  cloneWorkspaceWithProgress,
  detectRepositoryForge,
  fetchForgeTokenCredentials,
  isCredentialForForge,
} from '@/modules/project-creation-wizard/utils/workspaceApi';

/**
 * A stand-in for the browser's EventSource: records the URL it was opened
 * with and lets a test push server events through `onmessage`.
 */
class FakeEventSource {
  static opened: FakeEventSource[] = [];

  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.opened.push(this);
  }

  close() {
    this.closed = true;
  }

  emit(payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

type RecordedRequest = { url: string; init?: RequestInit };

const requests: RecordedRequest[] = [];

const respondToStart = (status: number, body: Record<string, unknown>) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }));
};

const cloneParams = {
  workspacePath: '/workspace/root',
  repositoryUrl: 'https://github.com/example/repo.git',
  forge: null,
  tokenMode: 'new' as const,
  selectedToken: '',
  newToken: 'ghp_supersecrettoken1234567890abcd',
};

beforeEach(() => {
  localStorage.clear();
  requests.length = 0;
  FakeEventSource.opened.length = 0;
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('cloneWorkspaceWithProgress posts the token in a body and opens the stream with only the clone id', async () => {
  respondToStart(200, { cloneId: 'clone-123' });
  const progress: string[] = [];

  const pending = cloneWorkspaceWithProgress(cloneParams, {
    onProgress: (message) => {
      progress.push(message);
    },
  });

  // The stream can only be opened once the POST has answered with an id.
  await vi.waitFor(() => assert.equal(FakeEventSource.opened.length, 1));

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, '/api/projects/clone');
  assert.equal(requests[0]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    path: '/workspace/root',
    repositoryUrl: 'https://github.com/example/repo.git',
    forge: null,
    tokenId: null,
    newToken: 'ghp_supersecrettoken1234567890abcd',
  });

  const stream = FakeEventSource.opened[0]!;
  assert.equal(stream.url, '/api/projects/clone-progress?cloneId=clone-123');
  assert.ok(!stream.url.includes(cloneParams.newToken), `token leaked into the stream URL: ${stream.url}`);

  stream.emit({ type: 'progress', message: 'Receiving objects: 100% (20/20), done.' });
  stream.emit({ type: 'complete', project: { projectId: 'project-1' } });

  assert.deepEqual(await pending, { projectId: 'project-1' });
  assert.deepEqual(progress, ['Receiving objects: 100% (20/20), done.']);
  assert.equal(stream.closed, true);
});

test('cloneWorkspaceWithProgress sends a stored token selection as its numeric id', async () => {
  respondToStart(200, { cloneId: 'clone-123' });

  const pending = cloneWorkspaceWithProgress(
    { ...cloneParams, forge: 'forgejo', tokenMode: 'stored', selectedToken: '12', newToken: '' },
    { onProgress: () => undefined },
  );
  await vi.waitFor(() => assert.equal(FakeEventSource.opened.length, 1));

  const body = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
  assert.equal(body.tokenId, 12);
  assert.equal(body.newToken, null);
  assert.equal(body.forge, 'forgejo');

  FakeEventSource.opened[0]!.emit({ type: 'complete', project: {} });
  await pending;
});

test('cloneWorkspaceWithProgress rejects with the server error and never opens a stream when the POST fails', async () => {
  respondToStart(400, { success: false, error: { code: 'INVALID', message: 'Invalid repositoryUrl' } });

  await assert.rejects(
    cloneWorkspaceWithProgress(cloneParams, { onProgress: () => undefined }),
    { message: 'Invalid repositoryUrl' },
  );
  assert.equal(FakeEventSource.opened.length, 0);
});

test('fetchForgeTokenCredentials loads GitHub and Forgejo tokens and keeps only active ones', async () => {
  const listedTypes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const credentialType = new URL(url, 'http://localhost').searchParams.get('type') ?? '';
    listedTypes.push(credentialType);
    const credentials = credentialType === 'github_token'
      ? [{ id: 1, credential_name: 'GitHub', credential_type: 'github_token', is_active: true }]
      : [
        { id: 2, credential_name: 'Codeberg', credential_type: 'forgejo_token', service_url: 'https://codeberg.org', is_active: true },
        { id: 3, credential_name: 'Old', credential_type: 'forgejo_token', service_url: 'https://codeberg.org', is_active: false },
      ];
    return new Response(JSON.stringify({ credentials }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));

  const tokens = await fetchForgeTokenCredentials();

  assert.deepEqual(listedTypes.sort(), ['forgejo_token', 'github_token']);
  assert.deepEqual(tokens.map((token) => token.id), [1, 2]);
  assert.equal(isCredentialForForge(tokens[0]!, 'github'), true);
  assert.equal(isCredentialForForge(tokens[1]!, 'github'), false);
  assert.equal(isCredentialForForge(tokens[1]!, 'forgejo'), true);
});

test('detectRepositoryForge asks the server about the URL', async () => {
  respondToStart(200, { forge: 'forgejo', instanceUrl: 'https://codeberg.org' });

  const result = await detectRepositoryForge('git@codeberg.org:team/repo.git');

  assert.deepEqual(result, { forge: 'forgejo', instanceUrl: 'https://codeberg.org' });
  assert.equal(requests[0]?.url, '/api/forges/detect?url=git%40codeberg.org%3Ateam%2Frepo.git');
});
