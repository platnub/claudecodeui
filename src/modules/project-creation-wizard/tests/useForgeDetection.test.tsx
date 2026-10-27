import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useForgeDetection } from '@/modules/project-creation-wizard/hooks/useForgeDetection';

const DETECTED_FORGES: Record<string, { forge: string | null; instanceUrl: string | null }> = {
  'https://codeberg.org/team/repo': { forge: 'forgejo', instanceUrl: 'https://codeberg.org' },
  'https://github.com/owner/repo': { forge: 'github', instanceUrl: null },
};

let resolvePendingRequests: Array<() => void> = [];

beforeEach(() => {
  localStorage.clear();
  resolvePendingRequests = [];
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const repositoryUrl = new URL(url, 'http://localhost').searchParams.get('url') ?? '';
    const response = new Response(JSON.stringify(DETECTED_FORGES[repositoryUrl] ?? { forge: null, instanceUrl: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    // Answers are released by the test, so the pending state can be observed.
    return new Promise<Response>((resolve) => { resolvePendingRequests.push(() => resolve(response)); });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const releaseRequests = () => {
  resolvePendingRequests.splice(0).forEach((release) => release());
};

test('the previous answer stands in, marked pending, while an edited URL is detected', async () => {
  const { result, rerender } = renderHook(
    ({ url }: { url: string }) => useForgeDetection(url, true),
    { initialProps: { url: 'https://codeberg.org/team/repo' } },
  );
  assert.equal(result.current.detecting, true);
  assert.equal(result.current.detected.forge, null);

  await waitFor(() => assert.equal(resolvePendingRequests.length, 1));
  releaseRequests();
  await waitFor(() => assert.equal(result.current.detecting, false));
  assert.deepEqual(result.current.detected, { forge: 'forgejo', instanceUrl: 'https://codeberg.org' });

  rerender({ url: 'https://github.com/owner/repo' });
  assert.equal(result.current.detecting, true);
  assert.equal(result.current.detected.forge, 'forgejo');

  await waitFor(() => assert.equal(resolvePendingRequests.length, 1));
  releaseRequests();
  await waitFor(() => assert.equal(result.current.detecting, false));
  assert.equal(result.current.detected.forge, 'github');
});

test('an empty or disabled URL reports nothing detected', () => {
  const { result } = renderHook(() => useForgeDetection('   ', true));
  assert.deepEqual(result.current, { detected: { forge: null, instanceUrl: null }, detecting: false });
});
