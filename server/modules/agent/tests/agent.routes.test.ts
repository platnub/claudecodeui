import assert from 'node:assert/strict';
import * as nodeCrypto from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import test, { after, before, mock } from 'node:test';

import express from 'express';

import { parseRepositoryUrl } from '@/modules/forges/index.js';

import { createAgentRouter } from '../agent.routes.js';

type AgentDependencies = Parameters<typeof createAgentRouter>[0];

// The route logs every step. Under `npm test` each file's output shares its
// stdout with the runner's serialized results, and this much of it makes
// Node's runner intermittently fail the whole file ("Unable to deserialize
// cloned data"). These tests assert on responses and calls, never on logs.
before(() => {
  mock.method(console, 'log', () => undefined);
  mock.method(console, 'error', () => undefined);
  mock.method(console, 'warn', () => undefined);
});
after(() => {
  mock.restoreAll();
});

function createDependencies(
  overrides: Partial<AgentDependencies> = {},
): AgentDependencies {
  const unexpectedProviderCall = async (): Promise<never> => {
    throw new Error('Provider runtime should not be called');
  };

  return {
    fileSystem: {} as AgentDependencies['fileSystem'],
    crypto: nodeCrypto,
    homeDirectory: () => '/home/test',
    spawnProcess: (() => { throw new Error('spawn should not run'); }) as unknown as
      AgentDependencies['spawnProcess'],
    platformMode: true,
    users: { getFirstUser: () => ({ id: 1, username: 'test-user' }) },
    apiKeys: { validateApiKey: () => undefined },
    githubTokens: { getActiveGithubToken: () => null },
    forgejoTokens: { getActiveForgejoToken: () => null },
    // Detection without the network or the credentials database: github.com
    // is GitHub, git.example.com is a Forgejo instance, anything else is unknown.
    forges: {
      resolveRepositoryForge: async (repositoryUrl: string, _userId: number, forgeOverride: 'github' | 'forgejo' | null = null) => {
        const repository = parseRepositoryUrl(repositoryUrl);
        if (!repository) return null;
        const detected = repository.host === 'github.com' ? 'github' : repository.host === 'git.example.com' ? 'forgejo' : null;
        const forge = forgeOverride ?? detected;
        return { repository, forge, instanceUrl: forge === 'forgejo' ? `${repository.webOrigin}${repository.basePath}` : null };
      },
      createForgejoPullRequest: async () => { throw new Error('Forgejo API should not be called'); },
    },
    projects: { createProjectPath: () => ({ outcome: 'created' }) },
    models: {} as AgentDependencies['models'],
    sessions: {
      getSessionById: () => null,
      getSessionByProviderSessionId: () => null,
      createAppSession: () => ({ sessionId: 'app-session-1' }),
    },
    // A registry stand-in: the runtime writes straight to the audience, which
    // is all the tests above this file's registration tests need.
    runs: {
      startRun: ((input: { connection: { send(data: string): void } | null }) => ({
        // The gateway writer's shape: a runtime that feature-detects it (codex)
        // hands it objects to serialize, as the real one expects.
        writer: { isWebSocketWriter: true, send: (data: unknown) => input.connection?.send(JSON.stringify(data)), getSessionId: () => null },
        events: [],
      })) as unknown as AgentDependencies['runs']['startRun'],
      completeRunIfCurrent: () => undefined,
      isProcessing: () => false,
    },
    queryClaude: unexpectedProviderCall as AgentDependencies['queryClaude'],
    queryCursor: unexpectedProviderCall as AgentDependencies['queryCursor'],
    queryCodex: unexpectedProviderCall as AgentDependencies['queryCodex'],
    queryOpenCode: unexpectedProviderCall as AgentDependencies['queryOpenCode'],
    GithubClient: class {} as unknown as AgentDependencies['GithubClient'],
    ...overrides,
  };
}

async function withAgentServer(
  dependencies: AgentDependencies,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', createAgentRouter(dependencies));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('Agent route rejects missing project input before invoking provider dependencies', async () => {
  await withAgentServer(createDependencies(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Inspect this project', stream: false }),
    });
    const body = await response.json() as { error: string };

    assert.equal(response.status, 400);
    assert.equal(body.error, 'Either repositoryUrl (or githubUrl) or projectPath is required');
  });
});

test('Agent route validates API keys through the injected repository', async () => {
  const receivedKeys: string[] = [];
  await withAgentServer(createDependencies({
    platformMode: false,
    apiKeys: {
      validateApiKey: (apiKey) => {
        receivedKeys.push(apiKey);
        return undefined;
      },
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'invalid-key' },
      body: JSON.stringify({ projectPath: '/workspace/project', message: 'Run' }),
    });
    assert.equal(response.status, 401);
  });

  assert.deepEqual(receivedKeys, ['invalid-key']);
});

test('Agent route rejects GitHub lookalike hosts before cloning', async () => {
  await withAgentServer(createDependencies(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        githubUrl: 'https://github.com.evil.example/owner/repo',
        message: 'Run',
        stream: false,
      }),
    });
    const body = await response.json() as { error: string };

    assert.equal(response.status, 500);
    assert.match(body.error, /Unsupported repository host/);
  });
});

test('GitHub cloning keeps credentials out of arguments and remote URL', async () => {
  const token = 'secret-token';
  let cloneArgs: readonly string[] = [];
  let cloneEnvironment: NodeJS.ProcessEnv | undefined;
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  await withAgentServer(createDependencies({
    fileSystem: {
      access: async () => { throw new Error('missing'); },
      mkdir: async () => undefined,
    } as unknown as AgentDependencies['fileSystem'],
    githubTokens: { getActiveGithubToken: () => token },
    spawnProcess: ((_command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      cloneArgs = args;
      cloneEnvironment = options.env;
      process.nextTick(() => child.emit('error', new Error('expected test failure')));
      return child;
    }) as unknown as AgentDependencies['spawnProcess'],
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        githubUrl: 'https://github.com/owner/repo.git',
        message: 'Run',
        stream: false,
      }),
    });
    assert.equal(response.status, 500);
  });

  assert.deepEqual(cloneArgs.slice(0, 5), [
    'clone', '--depth', '1', '--', 'https://github.com/owner/repo.git',
  ]);
  assert.equal(cloneArgs.length, 6);
  assert.equal(cloneArgs.join(' ').includes(token), false);
  assert.equal(cloneEnvironment?.CLOUDCLI_GIT_TOKEN, token);
  assert.equal(cloneEnvironment?.GIT_CONFIG_KEY_0, 'credential.helper');
  assert.equal(cloneEnvironment?.GIT_CONFIG_VALUE_0, '');
  assert.equal(cloneEnvironment?.GIT_CONFIG_KEY_1, 'credential.https://github.com.helper');
});

test('Agent route reuses a matching checkout without cloning or deleting it', async () => {
  const spawnedArguments: string[][] = [];
  const removedPaths: string[] = [];
  const spawnProcess = ((_command: string, args: readonly string[]) => {
    spawnedArguments.push([...args]);
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      child.stdout.end('https://github.com/owner/repo.git\n');
      child.emit('close', 0);
    });
    return child;
  }) as unknown as AgentDependencies['spawnProcess'];

  await withAgentServer(createDependencies({
    fileSystem: {
      access: async () => undefined,
      rm: async (targetPath: string) => { removedPaths.push(targetPath); },
    } as unknown as AgentDependencies['fileSystem'],
    spawnProcess,
    models: {
      getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'default-model' }),
    } as unknown as AgentDependencies['models'],
    queryClaude: (async () => undefined) as AgentDependencies['queryClaude'],
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        githubUrl: 'https://github.com/owner/repo.git',
        projectPath: '/home/test/.claude/external-projects/existing',
        message: 'Run',
        stream: false,
        cleanup: true,
      }),
    });
    assert.equal(response.status, 200);
  });

  assert.deepEqual(spawnedArguments, [['config', '--get', 'remote.origin.url']]);
  assert.deepEqual(removedPaths, []);
});

test('Agent route starts opencode on the catalog default when the request names no model', async () => {
  const opencodeCalls: { model?: string }[] = [];

  await withAgentServer(createDependencies({
    fileSystem: {
      access: async () => undefined,
    } as unknown as AgentDependencies['fileSystem'],
    models: {
      getProviderModels: async (provider: string) => ({ OPTIONS: [], DEFAULT: `${provider}-catalog-default` }),
    } as unknown as AgentDependencies['models'],
    queryOpenCode: (async (_prompt: string, options: { model?: string }) => {
      opencodeCalls.push(options);
    }) as unknown as AgentDependencies['queryOpenCode'],
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/home/test/project',
        message: 'Run',
        provider: 'opencode',
        stream: false,
      }),
    });
    assert.equal(response.status, 200);
  });

  assert.deepEqual(opencodeCalls.map((call) => call.model), ['opencode-catalog-default']);
});

test('Agent route starts codex on the catalog default when the request names no model', async () => {
  const codexCalls: { model?: string }[] = [];

  await withAgentServer(createDependencies({
    fileSystem: {
      access: async () => undefined,
    } as unknown as AgentDependencies['fileSystem'],
    models: {
      // `getProviderModels` resolves to a `ProviderModelsDefinition` - `OPTIONS`
      // and `DEFAULT`, with nothing wrapped around it.
      getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'catalog-default' }),
    } as unknown as AgentDependencies['models'],
    queryCodex: (async (_prompt: string, options: { model?: string }) => {
      codexCalls.push(options);
    }) as unknown as AgentDependencies['queryCodex'],
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/home/test/project',
        message: 'Run',
        provider: 'codex',
        stream: false,
      }),
    });
    assert.equal(response.status, 200);
  });

  assert.deepEqual(codexCalls.map((call) => call.model), ['catalog-default']);
});

/**
 * Runs one Agent request with no `model` against stub catalogs and returns the
 * model each provider runtime was started with, plus the catalogs read.
 */
async function runWithoutModel(
  provider: 'claude' | 'cursor',
  catalogs: Record<string, { OPTIONS: { value: string; isCustom?: boolean }[]; DEFAULT: string; CUSTOM_MODELS_ONLY?: boolean }>,
  requestedModel?: string,
): Promise<{ models: (string | undefined)[]; catalogReads: string[] }> {
  const models: (string | undefined)[] = [];
  const catalogReads: string[] = [];
  const recordModel = (async (_prompt: string, options: { model?: string }) => {
    models.push(options.model);
  }) as unknown as AgentDependencies['queryClaude'];

  await withAgentServer(createDependencies({
    fileSystem: {
      access: async () => undefined,
    } as unknown as AgentDependencies['fileSystem'],
    models: {
      getProviderModels: async (catalogProvider: string) => {
        catalogReads.push(catalogProvider);
        return catalogs[catalogProvider];
      },
    } as unknown as AgentDependencies['models'],
    queryClaude: recordModel,
    queryCursor: recordModel,
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/home/test/project',
        message: 'Run',
        provider,
        stream: false,
        ...(requestedModel ? { model: requestedModel } : {}),
      }),
    });
    assert.equal(response.status, 200);
  });

  return { models, catalogReads };
}

test('Agent route starts Claude and Cursor on the first custom model while only custom models are listed', async () => {
  // What the Providers service returns with "Use only my models" on.
  const customOnly = (value: string) => ({
    OPTIONS: [{ value, isCustom: true }, { value: `${value}-mini`, isCustom: true }],
    DEFAULT: value,
    CUSTOM_MODELS_ONLY: true,
  });
  const catalogs = { claude: customOnly('gateway/claude'), cursor: customOnly('gateway/cursor') };

  assert.deepEqual(await runWithoutModel('claude', catalogs), {
    models: ['gateway/claude'],
    catalogReads: ['claude'],
  });
  assert.deepEqual(await runWithoutModel('cursor', catalogs), {
    models: ['gateway/cursor'],
    catalogReads: ['cursor'],
  });
  // A model named in the request still wins.
  assert.deepEqual((await runWithoutModel('claude', catalogs, 'opus')).models, ['opus']);
  assert.deepEqual((await runWithoutModel('cursor', catalogs, 'gpt-5')).models, ['gpt-5']);
});

test('Agent route starts Claude on its built-in default and leaves Cursor to its CLI while built-in models are listed', async () => {
  const catalogs = {
    claude: {
      OPTIONS: [{ value: 'default', isCustom: false }, { value: 'gateway/claude', isCustom: true }],
      DEFAULT: 'default',
      CUSTOM_MODELS_ONLY: false,
    },
    cursor: {
      OPTIONS: [{ value: 'auto', isCustom: false }, { value: 'gateway/cursor', isCustom: true }],
      DEFAULT: 'auto',
      CUSTOM_MODELS_ONLY: false,
    },
  };

  // Claude's built-in DEFAULT is what its runtime falls back to anyway.
  assert.deepEqual((await runWithoutModel('claude', catalogs)).models, ['default']);
  // Cursor leaves the choice to its CLI, as before.
  assert.deepEqual((await runWithoutModel('cursor', catalogs)).models, [undefined]);

  // The flag on with no custom models lists the built-ins, so Cursor still
  // leaves the choice to its CLI.
  const flagWithoutCustomModels = {
    ...catalogs,
    cursor: { OPTIONS: [{ value: 'auto', isCustom: false }], DEFAULT: 'auto', CUSTOM_MODELS_ONLY: true },
  };
  assert.deepEqual((await runWithoutModel('cursor', flagWithoutCustomModels)).models, [undefined]);
});

test('Agent route reads no model catalog for a continued session of an unregistered provider', async () => {
  // A legacy row (e.g. 'gemini', removed in #964) has no catalog: the
  // Providers service throws "Unsupported provider" for it. Continuing such a
  // session runs no provider runtime, as before, instead of failing on the
  // catalog read.
  const catalogReads: string[] = [];

  await withAgentServer(createDependencies({
    fileSystem: {
      access: async () => undefined,
    } as unknown as AgentDependencies['fileSystem'],
    models: {
      getProviderModels: async (catalogProvider: string) => {
        catalogReads.push(catalogProvider);
        throw new Error(`Unsupported provider "${catalogProvider}"`);
      },
    } as unknown as AgentDependencies['models'],
    sessions: {
      getSessionById: () => ({
        session_id: 'legacy-session',
        provider: 'gemini',
        provider_session_id: null,
        project_path: '/home/test/project',
      }),
      getSessionByProviderSessionId: () => null,
      createAppSession: () => { throw new Error('a continued session must not create a row'); },
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/home/test/project',
        message: 'Run',
        sessionId: 'legacy-session',
        stream: false,
      }),
    });
    assert.equal(response.status, 200);
  });

  assert.deepEqual(catalogReads, []);
});

test('Forgejo cloning scopes the stored instance token to that instance', async () => {
  let cloneArgs: readonly string[] = [];
  let cloneEnvironment: NodeJS.ProcessEnv | undefined;
  const tokenLookups: Array<[number, string]> = [];
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  await withAgentServer(createDependencies({
    fileSystem: {
      access: async () => { throw new Error('missing'); },
      mkdir: async () => undefined,
    } as unknown as AgentDependencies['fileSystem'],
    forgejoTokens: {
      getActiveForgejoToken: (userId: number, instanceUrl: string) => {
        tokenLookups.push([userId, instanceUrl]);
        return 'forgejo-secret';
      },
    },
    spawnProcess: ((_command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      cloneArgs = args;
      cloneEnvironment = options.env;
      process.nextTick(() => child.emit('error', new Error('expected test failure')));
      return child;
    }) as unknown as AgentDependencies['spawnProcess'],
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repositoryUrl: 'https://git.example.com/team/repo.git', message: 'Run', stream: false }),
    });
    assert.equal(response.status, 500);
  });

  assert.deepEqual(tokenLookups, [[1, 'https://git.example.com']]);
  assert.equal(cloneArgs[4], 'https://git.example.com/team/repo.git');
  assert.equal(cloneArgs.join(' ').includes('forgejo-secret'), false);
  assert.equal(cloneEnvironment?.CLOUDCLI_GIT_TOKEN, 'forgejo-secret');
  assert.equal(cloneEnvironment?.GIT_CONFIG_KEY_1, 'credential.https://git.example.com.helper');
});

test('Agent route rejects a forge value it does not know', async () => {
  await withAgentServer(createDependencies(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: '/home/test/project', message: 'Run', forge: 'gitlab', stream: false }),
    });
    assert.equal(response.status, 400);
  });
});

test('Agent route pushes a branch and opens a Forgejo pull request for an ssh Forgejo remote', async () => {
  const spawnedArguments: string[][] = [];
  const pullRequests: unknown[] = [];
  const spawnProcess = ((_command: string, args: readonly string[]) => {
    spawnedArguments.push([...args]);
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args[0] === 'config') {
        child.stdout.end('git@git.example.com:team/repo.git\n');
      } else if (args[0] === 'log') {
        child.stdout.end('Add the feature');
      } else {
        child.stdout.end();
      }
      child.emit('close', 0);
    });
    return child;
  }) as unknown as AgentDependencies['spawnProcess'];

  let responseBody: { branch?: { name: string; url: string }; pullRequest?: { number: number; url: string } } = {};
  await withAgentServer(createDependencies({
    fileSystem: { access: async () => undefined } as unknown as AgentDependencies['fileSystem'],
    spawnProcess,
    models: {
      getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'default-model' }),
    } as unknown as AgentDependencies['models'],
    queryClaude: (async () => undefined) as AgentDependencies['queryClaude'],
    forgejoTokens: { getActiveForgejoToken: () => 'forgejo-secret' },
    forges: {
      ...createDependencies().forges,
      createForgejoPullRequest: async (input) => {
        pullRequests.push(input);
        return { number: 7, url: 'https://git.example.com/team/repo/pulls/7' };
      },
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectPath: '/home/test/project',
        message: 'Add the feature',
        branchName: 'feature/thing',
        createPR: true,
        stream: false,
      }),
    });
    assert.equal(response.status, 200);
    responseBody = await response.json() as typeof responseBody;
  });

  assert.deepEqual(responseBody.branch, {
    name: 'feature/thing',
    url: 'https://git.example.com/team/repo/src/branch/feature/thing',
  });
  assert.deepEqual(responseBody.pullRequest, { number: 7, url: 'https://git.example.com/team/repo/pulls/7' });
  assert.ok(spawnedArguments.some((args) => args.join(' ') === 'push -u origin feature/thing'));
  assert.equal(pullRequests.length, 1);
  const pullRequest = pullRequests[0] as { instanceUrl: string; token: string; head: string; base: string; title: string };
  assert.equal(pullRequest.instanceUrl, 'https://git.example.com');
  assert.equal(pullRequest.token, 'forgejo-secret');
  assert.equal(pullRequest.head, 'feature/thing');
  assert.equal(pullRequest.base, 'main');
  assert.equal(pullRequest.title, 'Add the feature');
});

/**
 * A git stand-in for the branch/PR path: `config` reports `remoteUrl`, every
 * other command succeeds. Records each command's arguments.
 */
function createGitRemoteSpawn(remoteUrl: string, spawnedArguments: string[][]) {
  return ((_command: string, args: readonly string[]) => {
    spawnedArguments.push([...args]);
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      child.stdout.end(args[0] === 'config' ? `${remoteUrl}\n` : '');
      child.emit('close', 0);
    });
    return child;
  }) as unknown as AgentDependencies['spawnProcess'];
}

for (const { remoteUrl, forge, expectedError } of [
  { remoteUrl: 'git@git.example.com:team/repo.git', forge: 'github', expectedError: /Invalid GitHub URL/ },
  { remoteUrl: 'git@github.com:owner/repo.git', forge: 'forgejo', expectedError: /github\.com is GitHub/ },
]) {
  test(`Agent route refuses forge "${forge}" for the remote ${remoteUrl} before pushing or opening a PR`, async () => {
    const spawnedArguments: string[][] = [];
    const pullRequests: unknown[] = [];
    let octokitCreated = false;
    let responseBody: { branch?: unknown; pullRequest?: { error?: string } } = {};

    await withAgentServer(createDependencies({
      fileSystem: { access: async () => undefined } as unknown as AgentDependencies['fileSystem'],
      spawnProcess: createGitRemoteSpawn(remoteUrl, spawnedArguments),
      models: {
        getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'default-model' }),
      } as unknown as AgentDependencies['models'],
      queryClaude: (async () => undefined) as AgentDependencies['queryClaude'],
      githubTokens: { getActiveGithubToken: () => 'github-secret' },
      forgejoTokens: { getActiveForgejoToken: () => 'forgejo-secret' },
      forges: {
        ...createDependencies().forges,
        createForgejoPullRequest: async (input) => {
          pullRequests.push(input);
          return { number: 1, url: 'unexpected' };
        },
      },
      GithubClient: class {
        constructor() { octokitCreated = true; }
      } as unknown as AgentDependencies['GithubClient'],
    }), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectPath: '/home/test/project',
          message: 'Add the feature',
          branchName: 'feature/thing',
          createPR: true,
          forge,
          forgejoToken: 'request-forgejo-secret',
          stream: false,
        }),
      });
      assert.equal(response.status, 200);
      responseBody = await response.json() as typeof responseBody;
    });

    assert.match(responseBody.pullRequest?.error ?? '', expectedError);
    assert.equal(spawnedArguments.some((args) => args[0] === 'push'), false);
    assert.equal(spawnedArguments.some((args) => args[0] === 'checkout'), false);
    assert.deepEqual(pullRequests, []);
    assert.equal(octokitCreated, false);
  });
}

test('Agent route refuses a link to a repository page before cloning', async () => {
  await withAgentServer(createDependencies(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repositoryUrl: 'https://git.example.com/team/repo/src/branch/main',
        message: 'Run',
        stream: false,
      }),
    });
    const body = await response.json() as { error: string };

    assert.equal(response.status, 500);
    assert.match(body.error, /link to a page of the repository/);
    assert.match(body.error, /Use https:\/\/git\.example\.com\/team\/repo$/);
  });
});
