import assert from 'node:assert/strict';
import test from 'node:test';

import { createForgeDetector } from '@/modules/forges/forge-detection.service.js';
import { createForgejoPullRequest, getBranchWebUrl } from '@/modules/forges/forgejo-api.service.js';
import { buildTokenCredentialEnvironment, getTokenCredentialOrigin } from '@/modules/forges/git-credentials.service.js';
import {
  getRepositoryWebUrl,
  normalizeForgejoInstanceUrl,
  parseRepositoryUrl,
  resolveForgejoInstanceUrl,
} from '@/modules/forges/repository-url.service.js';

test('parseRepositoryUrl reads https, ssh:// and scp-like remotes', () => {
  assert.deepEqual(parseRepositoryUrl('https://github.com/Owner/Repo.git'), {
    transport: 'https', host: 'github.com', webOrigin: 'https://github.com', basePath: '', owner: 'Owner', repo: 'Repo', webPagePath: '',
  });
  assert.deepEqual(parseRepositoryUrl('git@codeberg.org:team/project.git'), {
    transport: 'ssh', host: 'codeberg.org', webOrigin: 'https://codeberg.org', basePath: '', owner: 'team', repo: 'project', webPagePath: '',
  });
  assert.deepEqual(parseRepositoryUrl('ssh://git@git.example.com:2222/team/project.git'), {
    transport: 'ssh', host: 'git.example.com', webOrigin: 'https://git.example.com', basePath: '', owner: 'team', repo: 'project', webPagePath: '',
  });
  assert.deepEqual(parseRepositoryUrl('https://example.com:3000/forgejo/team/project/'), {
    transport: 'https', host: 'example.com', webOrigin: 'https://example.com:3000', basePath: '/forgejo', owner: 'team', repo: 'project', webPagePath: '',
  });
});

test('parseRepositoryUrl rejects what is not an owner/repo remote', () => {
  assert.equal(parseRepositoryUrl(''), null);
  assert.equal(parseRepositoryUrl('https://github.com/just-owner'), null);
  assert.equal(parseRepositoryUrl('file:///srv/git/repo.git'), null);
  assert.equal(parseRepositoryUrl('C:\\projects\\repo'), null);
});

test('parseRepositoryUrl reads a link to a repository page as that repository', () => {
  const forgejoPage = parseRepositoryUrl('https://codeberg.org/team/repo/src/branch/main');
  assert.equal(forgejoPage?.owner, 'team');
  assert.equal(forgejoPage?.repo, 'repo');
  assert.equal(forgejoPage?.basePath, '');
  assert.equal(forgejoPage?.webPagePath, '/src/branch/main');

  const githubPage = parseRepositoryUrl('https://github.com/owner/repo/tree/feature/thing');
  assert.equal(`${githubPage?.owner}/${githubPage?.repo}`, 'owner/repo');
  assert.equal(githubPage?.webPagePath, '/tree/feature/thing');

  const subPathPage = parseRepositoryUrl('https://example.com/forgejo/team/repo/src/commit/abc123');
  assert.equal(getRepositoryWebUrl(subPathPage!), 'https://example.com/forgejo/team/repo');
  assert.equal(subPathPage?.webPagePath, '/src/commit/abc123');

  // A repository named like a route, or a route with nothing after it, is a plain repository URL.
  assert.equal(parseRepositoryUrl('https://example.com/forgejo/team/tree')?.webPagePath, '');
  assert.equal(parseRepositoryUrl('https://codeberg.org/team/src')?.repo, 'src');
  assert.equal(parseRepositoryUrl('git@codeberg.org:team/repo/tree/main')?.webPagePath, '');
});

test('getRepositoryWebUrl keeps a sub-path install', () => {
  const repository = parseRepositoryUrl('https://example.com/forgejo/team/project.git');
  assert.equal(getRepositoryWebUrl(repository!), 'https://example.com/forgejo/team/project');
});

test('normalizeForgejoInstanceUrl accepts https instances only', () => {
  assert.equal(normalizeForgejoInstanceUrl('codeberg.org'), 'https://codeberg.org');
  assert.equal(normalizeForgejoInstanceUrl('https://Git.Example.com/'), 'https://git.example.com');
  assert.equal(normalizeForgejoInstanceUrl('https://example.com/forgejo/'), 'https://example.com/forgejo');
  assert.equal(normalizeForgejoInstanceUrl('http://git.example.com'), null);
  assert.equal(normalizeForgejoInstanceUrl('https://user:pw@git.example.com'), null);
  assert.equal(normalizeForgejoInstanceUrl(''), null);
});

test('resolveForgejoInstanceUrl matches an ssh remote to a stored sub-path instance by host', () => {
  const sshRepository = parseRepositoryUrl('git@example.com:team/project.git')!;
  assert.equal(resolveForgejoInstanceUrl(sshRepository, ['https://example.com/forgejo']), 'https://example.com/forgejo');
  assert.equal(resolveForgejoInstanceUrl(sshRepository, []), 'https://example.com');
});

test('the forge detector knows GitHub and Codeberg without probing', async () => {
  const probed: string[] = [];
  const detector = createForgeDetector(async (instanceUrl) => { probed.push(instanceUrl); return true; });

  assert.equal(await detector.detect('https://github.com/owner/repo'), 'github');
  assert.equal(await detector.detect('git@github.com:owner/repo.git'), 'github');
  assert.equal(await detector.detect('https://codeberg.org/owner/repo'), 'forgejo');
  assert.deepEqual(probed, []);
});

test('the forge detector treats a stored instance as Forgejo without probing it', async () => {
  const probed: string[] = [];
  const detector = createForgeDetector(async (instanceUrl) => { probed.push(instanceUrl); return false; });

  assert.equal(await detector.detect('git@git.example.com:team/repo.git', ['https://git.example.com/']), 'forgejo');
  assert.deepEqual(probed, []);
});

test('the forge detector probes an unknown host once and caches the answer', async () => {
  const probed: string[] = [];
  let currentTime = 0;
  const detector = createForgeDetector(
    async (instanceUrl) => { probed.push(instanceUrl); return instanceUrl === 'https://git.example.com'; },
    () => currentTime,
  );

  assert.equal(await detector.detect('https://git.example.com/team/repo.git'), 'forgejo');
  assert.equal(await detector.detect('https://git.example.com/team/other.git'), 'forgejo');
  assert.equal(await detector.detect('https://gitlab.example.com/team/repo.git'), null);
  assert.equal(await detector.detect('https://github.com.evil.example/owner/repo'), null);
  assert.deepEqual(probed, [
    'https://git.example.com',
    'https://gitlab.example.com',
    'https://github.com.evil.example',
  ]);

  // Past the cache lifetime the host is asked again.
  currentTime += 11 * 60 * 1000;
  await detector.detect('https://git.example.com/team/repo.git');
  assert.equal(probed.length, 4);
});

test('the forge detector never probes localhost or private addresses', async () => {
  const probed: string[] = [];
  const detector = createForgeDetector(async (instanceUrl) => { probed.push(instanceUrl); return true; });

  for (const url of [
    'https://localhost/team/repo',
    'http://localhost:3000/team/repo',
    'https://api.localhost/team/repo',
    'https://127.0.0.1/team/repo',
    'https://2130706433/team/repo',
    'git@2130706433:team/repo.git',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.5/team/repo',
    'https://172.20.1.1/team/repo',
    'https://192.168.1.10/team/repo',
    'https://100.64.0.1/team/repo',
    'https://0.0.0.0/team/repo',
    'https://[::1]/team/repo',
    'https://[fd00::1]/team/repo',
    'https://[fe80::1]/team/repo',
    'https://[::ffff:127.0.0.1]/team/repo',
  ]) {
    assert.equal(await detector.detect(url), null, url);
  }
  assert.deepEqual(probed, []);

  // A stored instance is trusted without a probe, private address or not.
  assert.equal(await detector.detect('https://192.168.1.10/team/repo', ['https://192.168.1.10']), 'forgejo');
  // Public addresses are still probed.
  assert.equal(await detector.detect('https://8.8.8.8/team/repo'), 'forgejo');
  assert.equal(await detector.detect('https://172.32.0.1/team/repo'), 'forgejo');
  assert.deepEqual(probed, ['https://8.8.8.8', 'https://172.32.0.1']);
});

test('the forge detector keeps a bounded probe cache, dropping the oldest answer', async () => {
  const probed: string[] = [];
  const detector = createForgeDetector(async (instanceUrl) => { probed.push(instanceUrl); return false; });

  for (let index = 0; index <= 256; index += 1) {
    await detector.detect(`https://host-${index}.example/team/repo`);
  }
  assert.equal(probed.length, 257);

  // host-1 is still cached; host-0 was evicted by host-256 and is asked again.
  await detector.detect('https://host-1.example/team/repo');
  assert.equal(probed.length, 257);
  await detector.detect('https://host-0.example/team/repo');
  assert.equal(probed.at(-1), 'https://host-0.example');
});

test('getTokenCredentialOrigin pins GitHub tokens to github.com and Forgejo tokens to https', () => {
  const forgejoRepository = parseRepositoryUrl('https://git.example.com:8443/team/repo.git')!;
  assert.equal(getTokenCredentialOrigin('forgejo', forgejoRepository), 'https://git.example.com:8443');
  assert.equal(getTokenCredentialOrigin('github', forgejoRepository), 'https://github.com');
  assert.equal(getTokenCredentialOrigin('forgejo', parseRepositoryUrl('http://git.example.com/team/repo')!), null);
  assert.equal(getTokenCredentialOrigin('forgejo', parseRepositoryUrl('git@git.example.com:team/repo')!), null);
});

test('buildTokenCredentialEnvironment keeps the token out of the helper text', () => {
  const environment = buildTokenCredentialEnvironment('secret-value', 'https://git.example.com', {});
  assert.equal(environment.GIT_CONFIG_KEY_1, 'credential.https://git.example.com.helper');
  assert.equal(environment.CLOUDCLI_GIT_TOKEN, 'secret-value');
  assert.ok(!(environment.GIT_CONFIG_VALUE_1 ?? '').includes('secret-value'));
  assert.equal(environment.GIT_TERMINAL_PROMPT, '0');
});

test('createForgejoPullRequest posts to the instance API with the token', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ number: 12, html_url: 'https://example.com/forgejo/team/repo/pulls/12' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const result = await createForgejoPullRequest({
    instanceUrl: 'https://example.com/forgejo',
    repository: parseRepositoryUrl('https://example.com/forgejo/team/repo.git')!,
    token: 'forgejo-secret',
    head: 'feature/x',
    base: 'main',
    title: 'Title',
    body: 'Body',
  }, fakeFetch);

  assert.deepEqual(result, { number: 12, url: 'https://example.com/forgejo/team/repo/pulls/12' });
  assert.equal(calls[0].url, 'https://example.com/forgejo/api/v1/repos/team/repo/pulls');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'token forgejo-secret');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { head: 'feature/x', base: 'main', title: 'Title', body: 'Body' });
});

test('createForgejoPullRequest surfaces Forgejo\'s error message', async () => {
  const fakeFetch = (async () => new Response(JSON.stringify({ message: 'pull request already exists' }), {
    status: 409,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;

  await assert.rejects(
    createForgejoPullRequest({
      instanceUrl: 'https://codeberg.org',
      repository: parseRepositoryUrl('https://codeberg.org/team/repo')!,
      token: 't', head: 'h', base: 'main', title: 'x', body: 'y',
    }, fakeFetch),
    /Forgejo API error \(409\): pull request already exists/,
  );
});

test('getBranchWebUrl uses each forge\'s branch route', () => {
  assert.equal(
    getBranchWebUrl('github', parseRepositoryUrl('git@github.com:owner/repo.git')!, 'feature/x'),
    'https://github.com/owner/repo/tree/feature/x',
  );
  assert.equal(
    getBranchWebUrl('forgejo', parseRepositoryUrl('https://codeberg.org/owner/repo')!, 'feature/x y'),
    'https://codeberg.org/owner/repo/src/branch/feature/x%20y',
  );
});
