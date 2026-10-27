import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useForgeTokens } from '@/modules/project-creation-wizard/hooks/useForgeTokens';
import type { GitForge } from '@/shared/types';

const STORED_TOKENS: Record<string, unknown[]> = {
  github_token: [{ id: 1, credential_name: 'GitHub', credential_type: 'github_token', is_active: true }],
  forgejo_token: [
    { id: 2, credential_name: 'Codeberg', credential_type: 'forgejo_token', service_url: 'https://codeberg.org', is_active: true },
    { id: 3, credential_name: 'Work', credential_type: 'forgejo_token', service_url: 'https://git.example.com', is_active: true },
  ],
};

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const credentialType = new URL(url, 'http://localhost').searchParams.get('type') ?? '';
    return new Response(JSON.stringify({ credentials: STORED_TOKENS[credentialType] ?? [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type HookProps = {
  forge: GitForge | null;
  repositoryUrl: string;
  instanceUrl: string | null;
  selectedTokenId: string;
  detecting?: boolean;
};

const renderTokens = (initialProps: HookProps) => {
  const selections: string[] = [];
  const hook = renderHook((props: HookProps) => useForgeTokens({
    ...props,
    detecting: props.detecting ?? false,
    shouldLoad: true,
    onAutoSelectToken: (tokenId) => { selections.push(tokenId); },
  }), { initialProps });
  return { ...hook, selections };
};

test('a GitHub repository is offered only GitHub tokens', async () => {
  const { result, selections } = renderTokens({
    forge: 'github', repositoryUrl: 'https://github.com/o/r', instanceUrl: null, selectedTokenId: '',
  });

  await waitFor(() => assert.deepEqual(result.current.tokens.map((token) => token.id), [1]));
  assert.deepEqual(selections, ['1']);
});

test('a Forgejo repository is offered only the tokens of its own instance', async () => {
  const { result } = renderTokens({
    forge: 'forgejo', repositoryUrl: 'https://git.example.com/team/repo.git', instanceUrl: null, selectedTokenId: '',
  });

  await waitFor(() => assert.deepEqual(result.current.tokens.map((token) => token.id), [3]));
});

test('switching host drops a selection the new host cannot use', async () => {
  const { result, rerender, selections } = renderTokens({
    forge: 'github', repositoryUrl: 'https://codeberg.org/team/repo', instanceUrl: null, selectedTokenId: '1',
  });
  await waitFor(() => assert.equal(result.current.tokens.length, 1));

  rerender({ forge: 'forgejo', repositoryUrl: 'https://codeberg.org/team/repo', instanceUrl: 'https://codeberg.org', selectedTokenId: '1' });

  await waitFor(() => assert.deepEqual(result.current.tokens.map((token) => token.id), [2]));
  assert.equal(selections.at(-1), '2');
});

test('an unrecognised host is offered no stored token', async () => {
  const { result, selections } = renderTokens({
    forge: null, repositoryUrl: 'https://unknown.example/team/repo', instanceUrl: null, selectedTokenId: '',
  });

  await waitFor(() => assert.equal(result.current.loading, false));
  assert.deepEqual(result.current.tokens, []);
  assert.deepEqual(selections, []);
});

test('a selection survives while the edited URL is being detected again', async () => {
  const codeberg = { forge: 'forgejo' as const, instanceUrl: 'https://codeberg.org', selectedTokenId: '2' };
  const { result, rerender, selections } = renderTokens({ ...codeberg, repositoryUrl: 'https://codeberg.org/team/rep' });
  await waitFor(() => assert.deepEqual(result.current.tokens.map((token) => token.id), [2]));

  // Mid-detection the host can read as unknown; the choice must not be dropped.
  rerender({ ...codeberg, forge: null, instanceUrl: null, repositoryUrl: 'https://codeberg.org/team/repo', detecting: true });
  rerender({ ...codeberg, repositoryUrl: 'https://codeberg.org/team/repo', detecting: false });

  await waitFor(() => assert.deepEqual(result.current.tokens.map((token) => token.id), [2]));
  assert.deepEqual(selections, []);
  assert.equal(result.current.selectedTokenName, 'Codeberg');
});
