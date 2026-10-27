// @ts-nocheck -- dynamic provider event payloads are normalized at the injected writer boundary.
import path from 'path';

import express from 'express';

import {
  buildTokenCredentialEnvironment,
  getBranchWebUrl,
  getRepositoryWebUrl,
  getTokenCredentialOrigin,
  parseRepositoryUrl,
} from '@/modules/forges/index.js';
import type { GitForge, ProviderRunFunction } from '@/shared/types.js';

import { normalizeProjectPath } from '../../shared/utils.js';

/** The forges a run can clone from and open a pull request on. */
const AGENT_FORGES: GitForge[] = ['github', 'forgejo'];

/** The providers an Agent API run can start: the ones with a runtime and a model catalog. */
const AGENT_RUN_PROVIDERS = ['claude', 'cursor', 'codex', 'opencode'];

/** What the route reads off a session row it continues: the row, not the request, says which provider and project a session belongs to. */
type AgentSessionRow = {
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  project_path: string | null;
};

type AgentRouterDependencies = {
  fileSystem: typeof import('node:fs/promises');
  crypto: typeof import('node:crypto');
  homeDirectory(): string;
  spawnProcess: typeof import('cross-spawn').default;
  platformMode: boolean;
  users: { getFirstUser(): unknown };
  apiKeys: { validateApiKey(apiKey: string): unknown };
  githubTokens: { getActiveGithubToken(userId: number): string | null };
  /** Stored Forgejo tokens: one per instance, looked up by the instance a repository resolves to. */
  forgejoTokens: { getActiveForgejoToken(userId: number, instanceUrl: string): string | null };
  /** Forge detection and the Forgejo API; GitHub goes through `GithubClient`. */
  forges: {
    resolveRepositoryForge: typeof import('../forges/index.js').resolveRepositoryForge;
    createForgejoPullRequest: typeof import('../forges/index.js').createForgejoPullRequest;
  };
  projects: { createProjectPath(projectPath: string, customName: string | null): unknown };
  models: typeof import('../providers/index.js').providerModelsService;
  /** The session gateway: an API run gets an app session row like a chat send, so the UI can list, open and subscribe to it. */
  sessions: {
    getSessionById(sessionId: string): AgentSessionRow | null;
    getSessionByProviderSessionId(providerSessionId: string): AgentSessionRow | null;
    createAppSession(provider: string, projectPath: string, initialMessage: string): { sessionId: string };
  };
  /** The live-run registry the chat socket uses; registering here is what puts an API run on the running-sessions list. */
  runs: Pick<typeof import('../websocket/index.js').chatRunRegistry, 'startRun' | 'completeRunIfCurrent' | 'isProcessing'>;
  queryClaude: ProviderRunFunction;
  queryCursor: ProviderRunFunction;
  queryCodex: ProviderRunFunction;
  queryOpenCode: ProviderRunFunction;
  GithubClient: typeof import('@octokit/rest').Octokit;
};

/**
 * Creates Agent routes around explicit authentication, repository, provider,
 * filesystem, subprocess, runtime, and forge (GitHub / Forgejo) dependencies.
 */
export function createAgentRouter(dependencies: AgentRouterDependencies): express.Router {
  const fs = dependencies.fileSystem;
  const crypto = dependencies.crypto;
  const os = { homedir: dependencies.homeDirectory };
  const spawn = dependencies.spawnProcess;
  const IS_PLATFORM = dependencies.platformMode;
  const userDb = dependencies.users;
  const apiKeysDb = dependencies.apiKeys;
  const githubTokensDb = dependencies.githubTokens;
  const forgejoTokensDb = dependencies.forgejoTokens;
  const forgeGateway = dependencies.forges;
  const projectsDb = dependencies.projects;
  const providerModelsService = dependencies.models;
  const sessionGateway = dependencies.sessions;
  const runRegistry = dependencies.runs;
  const queryClaudeSDK = dependencies.queryClaude;
  const spawnCursor = dependencies.queryCursor;
  const queryCodex = dependencies.queryCodex;
  const spawnOpenCode = dependencies.queryOpenCode;
  const Octokit = dependencies.GithubClient;
  const router = express.Router();

  /**
   * Middleware to authenticate agent API requests.
   *
   * Supports two authentication modes:
   * 1. Platform mode (IS_PLATFORM=true): For managed/hosted deployments where
   *    authentication is handled by an external proxy. Requests are trusted and
   *    the default user context is used.
   *
   * 2. API key mode (default): For self-hosted deployments where users authenticate
   *    via API keys created in the UI. Keys are validated against the local database.
   */
  const validateExternalApiKey = (req, res, next) => {
    // Platform mode: Authentication is handled externally (e.g., by a proxy layer).
    // Trust the request and use the default user context.
    if (IS_PLATFORM) {
      try {
        const user = userDb.getFirstUser();
        if (!user) {
          return res.status(500).json({ error: 'Platform mode: No user found in database' });
        }
        req.user = user;
        return next();
      } catch (error) {
        console.error('Platform mode error:', error);
        return res.status(500).json({ error: 'Platform mode: Failed to fetch user' });
      }
    }

    // Self-hosted mode: Validate API key from header or query parameter
    const apiKey = req.headers['x-api-key'] || req.query.apiKey;

    if (!apiKey) {
      return res.status(401).json({ error: 'API key required' });
    }

    const user = apiKeysDb.validateApiKey(apiKey);

    if (!user) {
      return res.status(401).json({ error: 'Invalid or inactive API key' });
    }

    req.user = user;
    next();
  };

  /**
   * Get the remote URL of a git repository
   * @param {string} repoPath - Path to the git repository
   * @returns {Promise<string>} - Remote URL of the repository
   */
  async function getGitRemoteUrl(repoPath) {
    return new Promise((resolve, reject) => {
      const gitProcess = spawn('git', ['config', '--get', 'remote.origin.url'], {
        cwd: repoPath,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      gitProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      gitProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      gitProcess.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Failed to get git remote: ${stderr}`));
        }
      });

      gitProcess.on('error', (error) => {
        reject(new Error(`Failed to execute git: ${error.message}`));
      });
    });
  }

  /**
   * Normalize a repository URL for comparison, so an ssh remote and the https
   * URL of the same repository compare equal.
   * @param {string} url - Repository URL (https or ssh)
   * @returns {string} - `host/sub-path/owner/repo`, lowercased
   */
  function normalizeRepositoryUrl(url) {
    const repository = parseRepositoryUrl(url);
    if (!repository) {
      return url.trim().replace(/\.git$/, '').replace(/\/$/, '').toLowerCase();
    }
    return `${repository.host}${repository.basePath}/${repository.owner}/${repository.repo}`.toLowerCase();
  }

  /**
   * The stored or request-supplied token for a forge.
   * @param {'github'|'forgejo'} forge - The repository's forge
   * @param {string|null} instanceUrl - The Forgejo instance (null for GitHub)
   * @param {object} requestTokens - `githubToken` / `forgejoToken` from the request
   * @param {number} userId - The authenticated user
   * @returns {string|null}
   */
  function resolveForgeToken(forge, instanceUrl, requestTokens, userId) {
    if (forge === 'github') {
      return requestTokens.githubToken || githubTokensDb.getActiveGithubToken(userId);
    }
    return requestTokens.forgejoToken || forgejoTokensDb.getActiveForgejoToken(userId, instanceUrl);
  }

  /**
   * Rejects a forge that cannot be the repository's host: GitHub lives only on
   * github.com, and github.com is never a Forgejo instance. Detection never
   * pairs them wrongly, but a caller's `forge` override can — and the token
   * and the pull request would then go to a different host than the remote.
   * Runs before cloning and before pushing a branch.
   * @param {{forge: 'github'|'forgejo'|null, repository: {host: string}}} resolved - From resolveRepositoryForge
   */
  function assertForgeMatchesHost(resolved) {
    if (resolved.forge === 'github' && resolved.repository.host !== 'github.com') {
      throw new Error('Invalid GitHub URL');
    }
    if (resolved.forge === 'forgejo' && resolved.repository.host === 'github.com') {
      throw new Error('github.com is GitHub, not a Forgejo instance');
    }
  }

  /**
   * Validates a clone URL and resolves its forge before git or a credential
   * is involved: https only, no credentials in the URL, a link to the
   * repository rather than one of its pages, and a host that is GitHub or a
   * Forgejo instance.
   * @param {string} repositoryUrl - The URL to clone
   * @param {'github'|'forgejo'|null} forgeOverride - The forge the caller named, if any
   * @param {number} userId - The authenticated user (whose stored instances count as Forgejo)
   * @returns {Promise<{cloneUrl: string, forge: 'github'|'forgejo', repository: object, instanceUrl: string|null}>}
   */
  async function resolveCloneTarget(repositoryUrl, forgeOverride, userId) {
    let parsedUrl;
    try {
      parsedUrl = new URL(repositoryUrl);
    } catch {
      throw new Error('Invalid repository URL');
    }
    if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) {
      throw new Error('Invalid repository URL');
    }
    const cloneUrl = parsedUrl.toString();

    const resolved = await forgeGateway.resolveRepositoryForge(cloneUrl, userId, forgeOverride);
    if (!resolved) {
      throw new Error('Invalid repository URL');
    }
    if (resolved.repository.webPagePath) {
      throw new Error(
        `This is a link to a page of the repository, not the repository itself. Use ${getRepositoryWebUrl(resolved.repository)}`,
      );
    }
    assertForgeMatchesHost(resolved);
    if (!resolved.forge) {
      throw new Error('Unsupported repository host: only GitHub and Forgejo repositories can be cloned');
    }
    return { cloneUrl, ...resolved };
  }

  /**
   * Auto-generate a branch name from a message
   * @param {string} message - The agent message
   * @returns {string} - Generated branch name
   */
  function autogenerateBranchName(message) {
    // Convert to lowercase, replace spaces/special chars with hyphens
    let branchName = message
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/-+/g, '-') // Replace multiple hyphens with single
      .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens

    // Ensure non-empty fallback
    if (!branchName) {
      branchName = 'task';
    }

    // Generate timestamp suffix (last 6 chars of base36 timestamp)
    const timestamp = Date.now().toString(36).slice(-6);
    const suffix = `-${timestamp}`;

    // Limit length to ensure total length including suffix fits within 50 characters
    const maxBaseLength = 50 - suffix.length;
    if (branchName.length > maxBaseLength) {
      branchName = branchName.substring(0, maxBaseLength);
    }

    // Remove any trailing hyphen after truncation and ensure no leading hyphen
    branchName = branchName.replace(/-$/, '').replace(/^-+/, '');

    // If still empty or starts with hyphen after cleanup, use fallback
    if (!branchName || branchName.startsWith('-')) {
      branchName = 'task';
    }

    // Combine base name with timestamp suffix
    branchName = `${branchName}${suffix}`;

    // Final validation: ensure it matches safe pattern
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(branchName)) {
      // Fallback to deterministic safe name
      return `branch-${timestamp}`;
    }

    return branchName;
  }

  /**
   * Validate a Git branch name
   * @param {string} branchName - Branch name to validate
   * @returns {{valid: boolean, error?: string}} - Validation result
   */
  function validateBranchName(branchName) {
    if (!branchName || branchName.trim() === '') {
      return { valid: false, error: 'Branch name cannot be empty' };
    }

    // Git branch name rules
    const invalidPatterns = [
      { pattern: /^\./, message: 'Branch name cannot start with a dot' },
      { pattern: /\.$/, message: 'Branch name cannot end with a dot' },
      { pattern: /\.\./, message: 'Branch name cannot contain consecutive dots (..)' },
      { pattern: /\s/, message: 'Branch name cannot contain spaces' },
      { pattern: /[~^:?*\[\\]/, message: 'Branch name cannot contain special characters: ~ ^ : ? * [ \\' },
      { pattern: /@{/, message: 'Branch name cannot contain @{' },
      { pattern: /\/$/, message: 'Branch name cannot end with a slash' },
      { pattern: /^\//, message: 'Branch name cannot start with a slash' },
      { pattern: /\/\//, message: 'Branch name cannot contain consecutive slashes' },
      { pattern: /\.lock$/, message: 'Branch name cannot end with .lock' }
    ];

    for (const { pattern, message } of invalidPatterns) {
      if (pattern.test(branchName)) {
        return { valid: false, error: message };
      }
    }

    // Check for ASCII control characters
    if (/[\x00-\x1F\x7F]/.test(branchName)) {
      return { valid: false, error: 'Branch name cannot contain control characters' };
    }

    return { valid: true };
  }

  /**
   * Get recent commit messages from a repository
   * @param {string} projectPath - Path to the git repository
   * @param {number} limit - Number of commits to retrieve (default: 5)
   * @returns {Promise<string[]>} - Array of commit messages
   */
  async function getCommitMessages(projectPath, limit = 5) {
    return new Promise((resolve, reject) => {
      const gitProcess = spawn('git', ['log', `-${limit}`, '--pretty=format:%s'], {
        cwd: projectPath,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      gitProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      gitProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      gitProcess.on('close', (code) => {
        if (code === 0) {
          const messages = stdout.trim().split('\n').filter(msg => msg.length > 0);
          resolve(messages);
        } else {
          reject(new Error(`Failed to get commit messages: ${stderr}`));
        }
      });

      gitProcess.on('error', (error) => {
        reject(new Error(`Failed to execute git: ${error.message}`));
      });
    });
  }

  /**
   * Create a pull request on GitHub
   * @param {Octokit} octokit - Octokit instance
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {string} branchName - Head branch name
   * @param {string} title - PR title
   * @param {string} body - PR body/description
   * @param {string} baseBranch - Base branch (default: 'main')
   * @returns {Promise<{number: number, url: string}>} - PR number and URL
   */
  async function createGitHubPR(octokit, owner, repo, branchName, title, body, baseBranch = 'main') {
    const { data: pr } = await octokit.pulls.create({
      owner,
      repo,
      title,
      head: branchName,
      base: baseBranch,
      body
    });

    console.log(`✅ Created pull request #${pr.number}: ${pr.html_url}`);

    return {
      number: pr.number,
      url: pr.html_url
    };
  }

  /**
   * Clone a GitHub or Forgejo repository to a directory
   * @param {{cloneUrl: string, forge: 'github'|'forgejo', repository: object}} cloneTarget - From resolveCloneTarget
   * @param {string|null} token - Optional forge token for private repos
   * @param {string} projectPath - Path for cloning the repository
   * @returns {Promise<{path: string, created: boolean}>} - Checkout path and ownership flag
   */
  async function cloneRepository(cloneTarget, token = null, projectPath) {
    return new Promise(async (resolve, reject) => {
      try {
        const cloneUrl = cloneTarget.cloneUrl;
        const cloneDir = path.resolve(projectPath);

        // Check if directory already exists
        try {
          await fs.access(cloneDir);
          // Directory exists - check if it's a git repo with the same URL
          try {
            const existingUrl = await getGitRemoteUrl(cloneDir);
            const normalizedExisting = normalizeRepositoryUrl(existingUrl);
            const normalizedRequested = normalizeRepositoryUrl(cloneUrl);

            if (normalizedExisting === normalizedRequested) {
              console.log('✅ Repository already exists at path with correct URL');
              return resolve({ path: cloneDir, created: false });
            } else {
              throw new Error(`Directory ${cloneDir} already exists with a different repository (${existingUrl}). Expected: ${cloneUrl}`);
            }
          } catch (gitError) {
            throw new Error(`Directory ${cloneDir} already exists but is not a valid git repository or git command failed`);
          }
        } catch (accessError) {
          // Directory doesn't exist - proceed with clone
        }

        // Ensure parent directory exists
        await fs.mkdir(path.dirname(cloneDir), { recursive: true });

        console.log(`🔄 Cloning ${cloneTarget.forge} repository:`, cloneUrl);
        console.log('📁 Destination:', cloneDir);

        // Execute git clone. The host was validated by resolveCloneTarget;
        // the helper is still scoped to that one https origin (github.com, or
        // the Forgejo instance) so the token can answer no other challenge
        // (a redirect, say). Without a token, prompts stay off so a private
        // repository fails instead of blocking on the server's terminal.
        const gitEnvironment = token
          ? buildTokenCredentialEnvironment(
            token,
            getTokenCredentialOrigin(cloneTarget.forge, cloneTarget.repository),
          )
          : { ...process.env, GIT_TERMINAL_PROMPT: '0' };
        const gitProcess = spawn('git', ['clone', '--depth', '1', '--', cloneUrl, cloneDir], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: gitEnvironment
        });

        let stdout = '';
        let stderr = '';

        gitProcess.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        gitProcess.stderr.on('data', (data) => {
          stderr += data.toString();
          console.log('Git stderr:', data.toString());
        });

        gitProcess.on('close', (code) => {
          if (code === 0) {
            console.log('✅ Repository cloned successfully');
            resolve({ path: cloneDir, created: true });
          } else {
            console.error('❌ Git clone failed:', stderr);
            reject(new Error(`Git clone failed: ${stderr}`));
          }
        });

        gitProcess.on('error', (error) => {
          reject(new Error(`Failed to execute git: ${error.message}`));
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Clean up a temporary project directory and its Claude session
   * @param {string} projectPath - Path to the project directory
   * @param {string} sessionId - Session ID to clean up
   */
  async function cleanupProject(projectPath, sessionId = null) {
    try {
      const externalProjectsRoot = await fs.realpath(
        path.join(os.homedir(), '.claude', 'external-projects')
      );
      const canonicalProjectPath = await fs.realpath(projectPath);
      const relativeProjectPath = path.relative(externalProjectsRoot, canonicalProjectPath);
      const isContained = relativeProjectPath !== ''
        && relativeProjectPath !== '..'
        && !relativeProjectPath.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relativeProjectPath);

      if (!isContained) {
        console.warn('⚠️ Refusing to clean up non-external project:', projectPath);
        return;
      }

      console.log('🧹 Cleaning up project:', projectPath);
      await fs.rm(canonicalProjectPath, { recursive: true, force: true });
      console.log('✅ Project cleaned up');

      // Also clean up the Claude session directory if sessionId provided
      if (sessionId) {
        try {
          const sessionPath = path.join(os.homedir(), '.claude', 'sessions', sessionId);
          console.log('🧹 Cleaning up session directory:', sessionPath);
          await fs.rm(sessionPath, { recursive: true, force: true });
          console.log('✅ Session directory cleaned up');
        } catch (error) {
          console.error('⚠️ Failed to clean up session directory:', error.message);
        }
      }
    } catch (error) {
      console.error('❌ Failed to clean up project:', error);
    }
  }

  /**
   * SSE Stream Writer - the HTTP response as one audience of a registered run.
   *
   * The provider runtime no longer writes here directly: it writes to the
   * run's gateway writer, which remaps, sequences and buffers every event
   * and forwards it — as a JSON string, the way it reaches a websocket — to
   * each connection watching the run, this one included. The route's own
   * events (status, session-id, forge results, done) are objects.
   */
  class SSEStreamWriter {
    constructor(res) {
      this.res = res;
    }

    /** What the gateway writer checks before forwarding: open until the response has ended. */
    get readyState() {
      return this.res.writableEnded ? 3 : 1;
    }

    send(data) {
      if (this.res.writableEnded) {
        return;
      }

      this.res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
    }

    end() {
      if (!this.res.writableEnded) {
        this.res.write('data: {"type":"done"}\n\n');
        this.res.end();
      }
    }
  }

  /**
   * Non-streaming response collector - the same audience role, kept in
   * memory until the run ends.
   */
  class ResponseCollector {
    constructor() {
      this.messages = [];
    }

    readyState = 1;

    send(data) {
      // The run's events arrive as JSON strings; the route's own as objects.
      // Stored as objects either way so the filters below read one shape.
      let record = data;
      if (typeof data === 'string') {
        try {
          record = JSON.parse(data);
        } catch (e) {
          // Not JSON, keep as is
        }
      }
      this.messages.push(record);
    }

    end() {
      // Do nothing - we'll collect all messages
    }

    getMessages() {
      return this.messages;
    }

    /**
     * The assistant's replies, as the normalized `text` events the run
     * produced. (Earlier versions filtered a `claude-response` shape no
     * runtime has emitted since the providers were unified, so this was
     * always empty.)
     */
    getAssistantMessages() {
      return this.messages.filter((msg) => msg && msg.kind === 'text' && msg.role === 'assistant');
    }

    /**
     * The run's token usage, from the last context-window report the
     * runtime streamed (`status` / `token_budget`, which the Claude and Codex
     * runtimes emit per assistant message); zeros for a runtime that
     * reports none.
     */
    getTotalTokens() {
      let budget = null;
      for (const msg of this.messages) {
        if (msg && msg.kind === 'status' && msg.text === 'token_budget' && msg.tokenBudget) {
          budget = msg.tokenBudget;
        }
      }
      const inputTokens = budget?.inputTokens ?? 0;
      const outputTokens = budget?.outputTokens ?? 0;
      return {
        inputTokens,
        outputTokens,
        cacheReadTokens: budget?.cacheReadTokens ?? 0,
        cacheCreationTokens: budget?.cacheCreationTokens ?? 0,
        totalTokens: inputTokens + outputTokens
      };
    }
  }

  // ===============================
  // External API Endpoint
  // ===============================

  /**
   * POST /api/agent
   *
   * Trigger an AI agent to work on a project.
   * Supports automatic branch and pull request creation on GitHub or Forgejo after successful completion.
   *
   * ================================================================================================
   * REQUEST BODY PARAMETERS
   * ================================================================================================
   *
   * @param {string} repositoryUrl - (Conditionally Required) GitHub or Forgejo repository URL to clone.
   *                             Aliases: `githubUrl` (the original name), `forgejoUrl`.
   *                             Cloning requires an https URL without credentials:
   *                             - GitHub: https://github.com/owner/repo(.git)
   *                             - Forgejo: https://codeberg.org/owner/repo(.git), https://git.example.com/owner/repo
   *                             The forge is detected from the host (see `forge`).
   *
   * @param {string} forge - (Optional) 'github' | 'forgejo'. Overrides detection. Omitted: github.com is
   *                         GitHub; codeberg.org and any instance you stored a Forgejo token for are Forgejo;
   *                         any other host is asked for Forgejo's version endpoint, except localhost and
   *                         private IP addresses, which are never probed. A host that is neither cannot be
   *                         cloned, or receive a branch/PR. An override must match the host: 'github' only
   *                         for github.com, 'forgejo' never for it.
   *
   * @param {string} projectPath - (Conditionally Required) Path to existing project OR destination for cloning.
   *                               Behavior depends on usage:
   *                               - If used alone: Must point to existing project directory
   *                               - If used with repositoryUrl: Target location for cloning
   *                               - If omitted with repositoryUrl: Auto-generates temporary path in ~/.claude/external-projects/
   *
   * @param {string} message - (Required) Task description for the AI agent. Used as:
   *                          - Instructions for the agent
   *                          - Source for auto-generated branch names (if createBranch=true and no branchName)
   *                          - Fallback for PR title if no commits are made
   *
   * @param {string} provider - (Optional) AI provider to use. Options: 'claude' | 'cursor' | 'codex' | 'opencode'
   *                           Default: 'claude'
   *
   * @param {boolean} stream - (Optional) Enable Server-Sent Events (SSE) streaming for real-time updates.
   *                          Default: true
   *                          - true: Returns text/event-stream with incremental updates
   *                          - false: Returns complete JSON response after completion
   *
   * @param {string} sessionId - (Optional) Continue an existing session: the id an earlier
   *                             response reported as `sessionId` / in its `session-id` event.
   *                             A session already mid-run is refused (409); an unknown id, 404.
   *                             Omitted: a new session is created for the run.
   *
   * @param {string} model - (Optional) Model identifier for providers.
   *                        Omitted: the provider's catalog DEFAULT from GET /api/providers/:provider/models,
   *                        which is the first custom model while "Use only my models" is on. Cursor
   *                        without that setting leaves the choice to its CLI.
   *
   *                        Claude models: 'default', 'sonnet', 'opus', 'haiku', 'sonnet[1m]', 'opus[1m]', 'fable'
   *                        Cursor models: 'gpt-5' (default), 'gpt-5.2', 'gpt-5.2-high', 'sonnet-4.5', 'opus-4.5',
   *                                       'composer-1', 'auto', 'gpt-5.1', 'gpt-5.1-high',
   *                                       'gpt-5.1-codex', 'gpt-5.1-codex-high', 'gpt-5.1-codex-max',
   *                                       'gpt-5.1-codex-max-high', 'opus-4.1', 'grok', and thinking variants
   *                        Codex models: 'gpt-5.4' (default), 'gpt-5.5', 'gpt-5.4-mini'
   *
   * @param {string} effort - (Optional) Reasoning effort for providers/models that support it.
   *                          Claude supports: 'low', 'medium', 'high', 'xhigh', 'max' depending on model.
   *                          Codex supports: 'low', 'medium', 'high', 'xhigh'.
   *                          'default' or omission lets the provider decide.
   *
   * @param {boolean} cleanup - (Optional) Auto-cleanup project directory after completion.
   *                           Default: true
   *                           Behavior:
   *                           - Only applies when cloning via repositoryUrl (not for existing projectPath)
   *                           - Deletes cloned repository after 5 seconds
   *                           - Also deletes associated Claude session directory
   *                           - Remote branch and PR remain on the forge if created
   *
   * @param {string} githubToken - (Optional) GitHub Personal Access Token for authentication.
   *                              Overrides stored token from user settings.
   *                              Required for:
   *                              - Private repositories
   *                              - Branch/PR creation features
   *                              Token must have 'repo' scope for full functionality.
   *
   * @param {string} forgejoToken - (Optional) Forgejo access token, the Forgejo counterpart of githubToken.
   *                              Overrides the token stored in settings for the repository's instance.
   *                              Needs the 'write:repository' scope for branch/PR creation.
   *
   * @param {string} branchName - (Optional) Custom name for the Git branch.
   *                             If provided, createBranch is automatically set to true.
   *                             Validation rules (errors returned if violated):
   *                             - Cannot be empty or whitespace only
   *                             - Cannot start or end with dot (.)
   *                             - Cannot contain consecutive dots (..)
   *                             - Cannot contain spaces
   *                             - Cannot contain special characters: ~ ^ : ? * [ \
   *                             - Cannot contain @{
   *                             - Cannot start or end with forward slash (/)
   *                             - Cannot contain consecutive slashes (//)
   *                             - Cannot end with .lock
   *                             - Cannot contain ASCII control characters
   *                             Examples: 'feature/user-auth', 'bugfix/login-error', 'refactor/db-optimization'
   *
   * @param {boolean} createBranch - (Optional) Create a new Git branch after successful agent completion.
   *                                Default: false (or true if branchName is provided)
   *                                Behavior:
   *                                - Creates branch locally and pushes to remote
   *                                - If branch exists locally: Checks out existing branch (no error)
   *                                - If branch exists on remote: Uses existing branch (no error)
   *                                - Branch name: Custom (if branchName provided) or auto-generated from message
   *                                - Requires either repositoryUrl OR projectPath with a GitHub or Forgejo remote
   *
   * @param {boolean} createPR - (Optional) Create a GitHub or Forgejo Pull Request after successful completion.
   *                            Default: false
   *                            Behavior:
   *                            - PR title: First commit message (or fallback to message parameter)
   *                            - PR description: Auto-generated from all commit messages
   *                            - Base branch: Always 'main' (currently hardcoded)
   *                            - If PR already exists: the forge returns an error with details
   *                            - Requires either repositoryUrl OR projectPath with a GitHub or Forgejo remote
   *
   * ================================================================================================
   * PATH HANDLING BEHAVIOR
   * ================================================================================================
   *
   * Scenario 1: Only repositoryUrl provided
   *   Input:  { repositoryUrl: "https://github.com/owner/repo" }
   *   Action: Clones to auto-generated temporary path: ~/.claude/external-projects/<hash>/
   *   Cleanup: Yes (if cleanup=true)
   *
   * Scenario 2: Only projectPath provided
   *   Input:  { projectPath: "/home/user/my-project" }
   *   Action: Uses existing project at specified path
   *   Validation: Path must exist and be accessible
   *   Cleanup: No (never cleanup existing projects)
   *
   * Scenario 3: Both repositoryUrl and projectPath provided
   *   Input:  { repositoryUrl: "https://codeberg.org/owner/repo", projectPath: "/custom/path" }
   *   Action: Clones repositoryUrl to projectPath location
   *   Validation:
   *     - If projectPath exists with git repo:
   *       - Compares remote URL with repositoryUrl
   *       - If URLs match: Reuses existing repo
   *       - If URLs differ: Returns error
   *   Cleanup: Yes (if cleanup=true)
   *
   * ================================================================================================
   * BRANCH/PR CREATION REQUIREMENTS (GITHUB AND FORGEJO)
   * ================================================================================================
   *
   * For createBranch or createPR to work, one of the following must be true:
   *
   * Option A: repositoryUrl provided
   *   - Repository URL directly specified
   *   - Works with both cloning and existing paths
   *
   * Option B: projectPath with a GitHub or Forgejo remote
   *   - Project must be a Git repository
   *   - Must have 'origin' remote configured (https or ssh)
   *   - Remote URL must point to github.com or a Forgejo instance (see `forge`)
   *   - System auto-detects the forge via: git config --get remote.origin.url
   *
   * Additional Requirements:
   *   - Valid token for that forge: GitHub (settings or githubToken), or Forgejo
   *     (a token stored for that instance in settings, or forgejoToken)
   *   - Token must have 'repo' (GitHub) / 'write:repository' (Forgejo) scope
   *   - Project must have commits (for PR creation)
   *
   * ================================================================================================
   * VALIDATION & ERROR HANDLING
   * ================================================================================================
   *
   * Input Validations (400 Bad Request):
   *   - Either repositoryUrl (or githubUrl/forgejoUrl) OR projectPath must be provided (not neither)
   *   - message must be non-empty string
   *   - provider must be 'claude', 'cursor', 'codex', or 'opencode'
   *   - forge, if given, must be 'github' or 'forgejo'
   *   - createBranch/createPR requires repositoryUrl OR projectPath (not neither)
   *   - branchName must pass Git naming rules (if provided)
   *
   * Runtime Validations (500 Internal Server Error or specific error in response):
   *   - projectPath must exist (if used alone)
   *   - Repository URL must be https, carry no credentials, and be on GitHub or Forgejo
   *   - Git remote must be a GitHub or Forgejo repository (for projectPath + branch/PR)
   *   - A token for that forge must be available (for private repos and branch/PR)
   *   - Directory conflicts handled (existing path with different repo)
   *
   * Branch Name Validation Errors (returned in response, not HTTP error):
   *   Invalid names return: { branch: { error: "Invalid branch name: <reason>" } }
   *   Examples:
   *   - "my branch" → "Branch name cannot contain spaces"
   *   - ".feature" → "Branch name cannot start with a dot"
   *   - "feature.lock" → "Branch name cannot end with .lock"
   *
   * ================================================================================================
   * RESPONSE FORMATS
   * ================================================================================================
   *
   * Every run is registered with the chat run registry like a message sent
   * from the UI: it is on GET /api/providers/sessions/running while it goes,
   * a tab that opens the session subscribes to it live, and its events
   * reach this response the way they reach a tab — `sessionId` is the app
   * session id, each event carries a `seq`, and the provider's own
   * `session_created` is folded into the session row instead of forwarded.
   *
   * Streaming Response (stream=true):
   *   Content-Type: text/event-stream
   *   Events:
   *     - { type: "status", message: "...", projectPath: "..." }
   *     - { type: "session-id", sessionId: "..." }   // the app session id, usable as `sessionId` later
   *     - { kind: "text" | "tool_use" | ... , sessionId, seq, ... }   // the provider's normalized events
   *     - { kind: "complete", ... }
   *     - { type: "status", message: "Run aborted", aborted: true }   // only when a tab aborted the run; no branch/PR follows
   *     - { type: "github-branch" | "forgejo-branch", forge, branch: { name: "...", url: "..." } }
   *     - { type: "github-pr" | "forgejo-pr", forge, pullRequest: { number: 42, url: "..." } }
   *     - { type: "github-error" | "forgejo-error", forge, error: "..." }
   *     - { type: "done" }
   *
   * Non-Streaming Response (stream=false):
   *   Content-Type: application/json
   *   {
   *     success: true,          // false, with aborted: true, when a tab aborted the run
   *     sessionId: "session-123",          // the app session id; pass it back as `sessionId` to continue
   *     providerSessionId: "native-id",    // the provider's own id, for tooling that drives the CLI directly
   *     messages: [...],        // The assistant's replies: the run's normalized `text` events
   *     tokens: {
   *       inputTokens: 150,
   *       outputTokens: 50,
   *       cacheReadTokens: 0,
   *       cacheCreationTokens: 0,
   *       totalTokens: 200
   *     },
   *     projectPath: "/path/to/project",
   *     branch: {               // Only if createBranch=true
   *       name: "feature/xyz",
   *       url: "https://github.com/owner/repo/tree/feature/xyz"   // Forgejo: .../src/branch/feature/xyz
   *     } | { error: "..." },
   *     pullRequest: {          // Only if createPR=true
   *       number: 42,
   *       url: "https://github.com/owner/repo/pull/42"   // Forgejo: .../pulls/42
   *     } | { error: "..." }
   *   }
   *
   * Error Response:
   *   HTTP Status: 400, 401, 404 (unknown sessionId), 409 (session already mid-run), 500
   *   Content-Type: application/json
   *   { success: false, error: "Error description" }
   *
   * ================================================================================================
   * EXAMPLES
   * ================================================================================================
   *
   * Example 1: Clone and process with auto-cleanup
   *   POST /api/agent
   *   { "repositoryUrl": "https://github.com/user/repo", "message": "Fix bug" }
   *
   * Example 2: Use existing project with custom branch and PR
   *   POST /api/agent
   *   {
   *     "projectPath": "/home/user/project",
   *     "message": "Add feature",
   *     "branchName": "feature/new-feature",
   *     "createPR": true
   *   }
   *
   * Example 3: Clone a Forgejo repository to a specific path with auto-generated branch
   *   POST /api/agent
   *   {
   *     "repositoryUrl": "https://codeberg.org/user/repo",
   *     "projectPath": "/tmp/work",
   *     "message": "Refactor code",
   *     "createBranch": true,
   *     "cleanup": false
   *   }
   */
  router.post('/', validateExternalApiKey, async (req, res) => {
    const { projectPath, message, model, githubToken, forgejoToken, branchName } = req.body;
    // `repositoryUrl` names a GitHub or Forgejo repository; `githubUrl` and
    // `forgejoUrl` are accepted as aliases (`githubUrl` predates Forgejo).
    const repositoryUrl = [req.body.repositoryUrl, req.body.githubUrl, req.body.forgejoUrl]
      .find((value) => typeof value === 'string' && value.trim())?.trim() ?? null;
    if (req.body.forge !== undefined && req.body.forge !== null && !AGENT_FORGES.includes(req.body.forge)) {
      return res.status(400).json({ error: 'forge must be "github" or "forgejo"' });
    }
    // Omitted: detected from the URL (github.com, a Forgejo instance the user
    // stored a token for, or one that answers Forgejo's version endpoint).
    const requestedForge = req.body.forge ?? null;
    // Transport input is typed here, before anything binds it to a query:
    // the lookup below runs outside the try, where a throw would be an
    // unhandled rejection.
    if (req.body.sessionId !== undefined && req.body.sessionId !== null && typeof req.body.sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId must be a string' });
    }
    const sessionId = typeof req.body.sessionId === 'string' && req.body.sessionId.trim() ? req.body.sessionId.trim() : null;
    const requestedProvider = req.body.provider === undefined || req.body.provider === null ? null : req.body.provider;
    const effort = typeof req.body.effort === 'string' && req.body.effort.trim()
      ? req.body.effort.trim()
      : undefined;

    // Parse stream and cleanup as booleans (handle string "true"/"false" from curl)
    const stream = req.body.stream === undefined ? true : (req.body.stream === true || req.body.stream === 'true');
    const cleanup = req.body.cleanup === undefined ? true : (req.body.cleanup === true || req.body.cleanup === 'true');

    // If branchName is provided, automatically enable createBranch
    const createBranch = branchName ? true : (req.body.createBranch === true || req.body.createBranch === 'true');
    const createPR = req.body.createPR === true || req.body.createPR === 'true';

    // Validate inputs
    if (!repositoryUrl && !projectPath) {
      return res.status(400).json({ error: 'Either repositoryUrl (or githubUrl) or projectPath is required' });
    }

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    if (requestedProvider !== null && !AGENT_RUN_PROVIDERS.includes(requestedProvider)) {
      return res.status(400).json({ error: 'provider must be "claude", "cursor", "codex", or "opencode"' });
    }

    // Validate branch/PR creation requirements
    // Allow branch/PR creation with projectPath as long as it has a GitHub or Forgejo remote
    if ((createBranch || createPR) && !repositoryUrl && !projectPath) {
      return res.status(400).json({ error: 'createBranch and createPR require either repositoryUrl or projectPath with a GitHub or Forgejo remote' });
    }

    // A run continues a session the caller names, by its app id or — for a
    // caller that stored what an earlier response called `sessionId` — the
    // provider-native one, which the row is also keyed by once indexed. The
    // row, not the request, says which provider the session belongs to, as
    // it does for a chat send; a request that names another is refused.
    let sessionRow = null;
    if (sessionId) {
      sessionRow = sessionGateway.getSessionById(sessionId) ?? sessionGateway.getSessionByProviderSessionId(sessionId);
      if (!sessionRow) {
        return res.status(404).json({ error: `Session "${sessionId}" was not found` });
      }
      if (requestedProvider !== null && requestedProvider !== sessionRow.provider) {
        return res.status(400).json({ error: `Session "${sessionRow.session_id}" belongs to provider "${sessionRow.provider}"` });
      }
      // Refused before any side effect — a clone per retry would pile up
      // under external-projects. startRun below still has the last word.
      if (runRegistry.isProcessing(sessionRow.session_id)) {
        return res.status(409).json({ error: `Session "${sessionRow.session_id}" already has a run in progress` });
      }
    }
    const provider = sessionRow?.provider ?? requestedProvider ?? 'claude';

    let finalProjectPath = null;
    let clonedProjectCreated = false;
    let writer = null;
    // The run as the chat socket registers one: on the running-sessions
    // list, subscribable from any tab, and completed on every exit path.
    let run = null;

    try {
      // Determine the final project path
      if (repositoryUrl) {
        // Clone repository (to projectPath if provided, otherwise generate path)
        const cloneTarget = await resolveCloneTarget(repositoryUrl, requestedForge, req.user.id);
        const tokenToUse = resolveForgeToken(
          cloneTarget.forge,
          cloneTarget.instanceUrl,
          { githubToken, forgejoToken },
          req.user.id,
        );

        let targetPath;
        if (projectPath) {
          targetPath = projectPath;
        } else {
          // Generate a unique path for cloning
          const repoHash = crypto.createHash('md5').update(repositoryUrl + Date.now()).digest('hex');
          targetPath = path.join(os.homedir(), '.claude', 'external-projects', repoHash);
        }

        const clonedProject = await cloneRepository(cloneTarget, tokenToUse, targetPath);
        finalProjectPath = clonedProject.path;
        clonedProjectCreated = clonedProject.created;
      } else {
        // Use existing project path
        finalProjectPath = normalizeProjectPath(path.resolve(projectPath));

        // Verify the path exists
        try {
          await fs.access(finalProjectPath);
        } catch (error) {
          throw new Error(`Project path does not exist: ${finalProjectPath}`);
        }
      }

      finalProjectPath = normalizeProjectPath(finalProjectPath);

      // A continued session runs where it lives, as a chat send does; a
      // request that resolved to another directory is not that session.
      if (sessionRow && sessionRow.project_path && normalizeProjectPath(sessionRow.project_path) !== finalProjectPath) {
        throw new Error(`Session "${sessionRow.session_id}" belongs to project ${sessionRow.project_path}, not ${finalProjectPath}`);
      }

      // Register project path in DB (or reuse existing active registration)
      const registrationResult = projectsDb.createProjectPath(finalProjectPath, null);
      if (registrationResult.outcome === 'active_conflict') {
        console.log('Project registration already exists for:', finalProjectPath);
      } else {
        console.log('Project registered:', registrationResult.project);
      }

      // A brand-new run gets its app session row first, as a chat send does:
      // the id is stable for the conversation, the sidebar can list it, and
      // the provider-native id is mapped onto it when the runtime announces it.
      const appSessionId = sessionRow
        ? sessionRow.session_id
        : sessionGateway.createAppSession(provider, finalProjectPath, message.trim()).sessionId;

      // Registered before any header goes out, so a session already mid-run
      // is refused with a plain 409 rather than an empty stream. The HTTP
      // response is the run's first audience; a tab that opens the session
      // subscribes as another, and replays what it missed.
      const audience = stream ? new SSEStreamWriter(res) : new ResponseCollector();
      run = runRegistry.startRun({
        appSessionId,
        provider,
        providerSessionId: sessionRow?.provider_session_id ?? null,
        connection: audience,
        userId: req.user.id,
      });
      if (!run) {
        if (cleanup && repositoryUrl && clonedProjectCreated) {
          cleanupProject(finalProjectPath, null);
        }
        return res.status(409).json({ error: `Session "${appSessionId}" already has a run in progress` });
      }
      writer = audience;

      if (stream) {
        // Set up SSE headers for streaming
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
      }

      // The route's own opening events. `session-id` is the app session id:
      // what the UI opens the conversation under, and what a later request
      // passes back as `sessionId` to continue it.
      writer.send({
        type: 'status',
        message: repositoryUrl ? 'Repository cloned and session started' : 'Session started',
        projectPath: finalProjectPath
      });
      writer.send({ type: 'session-id', sessionId: appSessionId });

      // A request without `model` runs on the catalog's DEFAULT, the value
      // /api/providers/:provider/models and the API docs advertise. It is the
      // first custom model while the provider lists only custom models.
      // Only the four runnable providers have a catalog: a continued legacy
      // session whose provider is no longer registered must not fail here.
      const providerModels = AGENT_RUN_PROVIDERS.includes(provider)
        ? await providerModelsService.getProviderModels(provider)
        : null;
      // Cursor otherwise leaves the choice to its CLI, so it only takes the
      // catalog DEFAULT when that is one of the user's own models.
      const cursorDefaultModel = providerModels?.CUSTOM_MODELS_ONLY === true
        && providerModels.OPTIONS.some((option) => option.isCustom)
        ? providerModels.DEFAULT
        : undefined;

      // Start the appropriate session
      if (provider === 'claude') {
        console.log('🤖 Starting Claude SDK session');

        await queryClaudeSDK(message.trim(), {
          projectPath: finalProjectPath,
          cwd: finalProjectPath,
          sessionId: appSessionId,
          model: model || providerModels?.DEFAULT,
          effort,
          permissionMode: 'bypassPermissions' // Bypass all permissions for API calls
        }, run.writer);

      } else if (provider === 'cursor') {
        console.log('🖱️ Starting Cursor CLI session');

        await spawnCursor(message.trim(), {
          projectPath: finalProjectPath,
          cwd: finalProjectPath,
          sessionId: appSessionId,
          model: model || cursorDefaultModel,
          skipPermissions: true // Bypass permissions for Cursor
        }, run.writer);
      } else if (provider === 'codex') {
        console.log('🤖 Starting Codex SDK session');

        await queryCodex(message.trim(), {
          projectPath: finalProjectPath,
          cwd: finalProjectPath,
          sessionId: appSessionId,
          model: model || providerModels?.DEFAULT,
          effort,
          permissionMode: 'bypassPermissions'
        }, run.writer);
      } else if (provider === 'opencode') {
        console.log('Starting OpenCode CLI session');

        await spawnOpenCode(message.trim(), {
          projectPath: finalProjectPath,
          cwd: finalProjectPath,
          sessionId: appSessionId,
          model: model || providerModels?.DEFAULT,
          effort,
          permissionMode: 'bypassPermissions' // Agent runs are non-interactive, like the other providers above
        }, run.writer);
      }

      // A tab can now abort the run (`chat.abort`), on which the runtime
      // returns as it does on completion. What the interrupted agent left
      // behind is not a result to branch or open a PR from.
      const aborted = run.events.some((event) => event.kind === 'complete' && event.aborted === true);
      if (aborted) {
        writer.send({ type: 'status', message: 'Run aborted', aborted: true });
      }

      // Handle branch and PR creation (GitHub or Forgejo) after successful agent completion
      let branchInfo = null;
      let prInfo = null;

      if (!aborted && (createBranch || createPR)) {
        // Known once the remote is resolved; names the stream events
        // (`github-*` / `forgejo-*`). An error before that reports as the
        // forge the caller asked for, else GitHub, as it always did.
        let forge = null;
        try {
          console.log('🔄 Starting branch/PR creation workflow...');

          // Get the repository URL - either from parameter or from git remote
          let repoUrl = repositoryUrl;
          if (!repoUrl) {
            console.log('🔍 Getting repository URL from git remote...');
            try {
              repoUrl = await getGitRemoteUrl(finalProjectPath);
            } catch (error) {
              throw new Error(`Failed to get repository remote URL: ${error.message}`);
            }
          }

          const resolvedRemote = await forgeGateway.resolveRepositoryForge(repoUrl, req.user.id, requestedForge);
          if (!resolvedRemote?.forge) {
            throw new Error('Project does not have a GitHub or Forgejo remote configured');
          }
          // Before the push: an override naming the wrong forge must not send
          // the branch to the remote and the pull request somewhere else.
          assertForgeMatchesHost(resolvedRemote);
          forge = resolvedRemote.forge;
          const { repository, instanceUrl } = resolvedRemote;
          const { owner, repo } = repository;
          console.log(`✅ Found ${forge} remote: ${repoUrl}`);
          console.log(`📦 Repository: ${owner}/${repo}`);

          // Get the forge token
          const tokenToUse = resolveForgeToken(forge, instanceUrl, { githubToken, forgejoToken }, req.user.id);
          if (!tokenToUse) {
            throw new Error(forge === 'github'
              ? 'GitHub token required for branch/PR creation. Please configure a GitHub token in settings.'
              : `Forgejo token required for branch/PR creation. Please add a Forgejo token for ${instanceUrl} in settings.`);
          }

          // Use provided branch name or auto-generate from message
          const finalBranchName = branchName || autogenerateBranchName(message);
          if (branchName) {
            console.log(`🌿 Using provided branch name: ${finalBranchName}`);

            // Validate custom branch name
            const validation = validateBranchName(finalBranchName);
            if (!validation.valid) {
              throw new Error(`Invalid branch name: ${validation.error}`);
            }
          } else {
            console.log(`🌿 Auto-generated branch name: ${finalBranchName}`);
          }

          if (createBranch) {
            // Create and checkout the new branch locally
            console.log('🔄 Creating local branch...');
            const checkoutProcess = spawn('git', ['checkout', '-b', finalBranchName], {
              cwd: finalProjectPath,
              stdio: 'pipe'
            });

            await new Promise((resolve, reject) => {
              let stderr = '';
              checkoutProcess.stderr.on('data', (data) => { stderr += data.toString(); });
              checkoutProcess.on('close', (code) => {
                if (code === 0) {
                  console.log(`✅ Created and checked out local branch '${finalBranchName}'`);
                  resolve();
                } else {
                  // Branch might already exist locally, try to checkout
                  if (stderr.includes('already exists')) {
                    console.log(`ℹ️ Branch '${finalBranchName}' already exists locally, checking out...`);
                    const checkoutExisting = spawn('git', ['checkout', finalBranchName], {
                      cwd: finalProjectPath,
                      stdio: 'pipe'
                    });
                    checkoutExisting.on('close', (checkoutCode) => {
                      if (checkoutCode === 0) {
                        console.log(`✅ Checked out existing branch '${finalBranchName}'`);
                        resolve();
                      } else {
                        reject(new Error(`Failed to checkout existing branch: ${stderr}`));
                      }
                    });
                  } else {
                    reject(new Error(`Failed to create branch: ${stderr}`));
                  }
                }
              });
            });

            // Push the branch to remote. `repoUrl` is origin's URL (read from
            // it, or the URL the API itself cloned origin from), and the forge
            // was checked against its host above, so the token is scoped to
            // origin's https origin. Forgejo over ssh/http has no such origin:
            // the push then relies on the machine's ssh keys and never sees
            // the token. Prompts stay off so git cannot block on the server's
            // terminal.
            console.log('🔄 Pushing branch to remote...');
            const pushCredentialOrigin = getTokenCredentialOrigin(forge, repository);
            const pushEnvironment = pushCredentialOrigin
              ? buildTokenCredentialEnvironment(tokenToUse, pushCredentialOrigin)
              : { ...process.env, GIT_TERMINAL_PROMPT: '0' };
            const pushProcess = spawn('git', ['push', '-u', 'origin', finalBranchName], {
              cwd: finalProjectPath,
              stdio: 'pipe',
              env: pushEnvironment
            });

            await new Promise((resolve, reject) => {
              let stderr = '';
              let stdout = '';
              pushProcess.stdout.on('data', (data) => { stdout += data.toString(); });
              pushProcess.stderr.on('data', (data) => { stderr += data.toString(); });
              pushProcess.on('close', (code) => {
                if (code === 0) {
                  console.log(`✅ Pushed branch '${finalBranchName}' to remote`);
                  resolve();
                } else {
                  // Check if branch exists on remote but has different commits
                  if (stderr.includes('already exists') || stderr.includes('up-to-date')) {
                    console.log(`ℹ️ Branch '${finalBranchName}' already exists on remote, using existing branch`);
                    resolve();
                  } else {
                    reject(new Error(`Failed to push branch: ${stderr}`));
                  }
                }
              });
            });

            branchInfo = {
              name: finalBranchName,
              url: getBranchWebUrl(forge, repository, finalBranchName)
            };
          }

          if (createPR) {
            // Get commit messages to generate PR description
            console.log('🔄 Generating PR title and description...');
            const commitMessages = await getCommitMessages(finalProjectPath, 5);

            // Use the first commit message as the PR title, or fallback to the agent message
            const prTitle = commitMessages.length > 0 ? commitMessages[0] : message;

            // Generate PR body from commit messages
            let prBody = '## Changes\n\n';
            if (commitMessages.length > 0) {
              prBody += commitMessages.map(msg => `- ${msg}`).join('\n');
            } else {
              prBody += `Agent task: ${message}`;
            }
            prBody += '\n\n---\n*This pull request was automatically created by CloudCLI.ai Agent.*';

            console.log(`📝 PR Title: ${prTitle}`);

            // Create the pull request
            console.log(`🔄 Creating ${forge} pull request...`);
            if (forge === 'github') {
              const octokit = new Octokit({ auth: tokenToUse });
              prInfo = await createGitHubPR(octokit, owner, repo, finalBranchName, prTitle, prBody, 'main');
            } else {
              prInfo = await forgeGateway.createForgejoPullRequest({
                instanceUrl,
                repository,
                token: tokenToUse,
                head: finalBranchName,
                base: 'main',
                title: prTitle,
                body: prBody,
              });
              console.log(`✅ Created pull request #${prInfo.number}: ${prInfo.url}`);
            }
          }

          // Send branch/PR info in response
          if (stream) {
            if (branchInfo) {
              writer.send({
                type: `${forge}-branch`,
                forge,
                branch: branchInfo
              });
            }
            if (prInfo) {
              writer.send({
                type: `${forge}-pr`,
                forge,
                pullRequest: prInfo
              });
            }
          }

        } catch (error) {
          console.error('❌ Branch/PR creation error:', error);
          const reportedForge = forge ?? requestedForge ?? 'github';

          // Send error but don't fail the entire request
          if (stream) {
            writer.send({
              type: `${reportedForge}-error`,
              forge: reportedForge,
              error: error.message
            });
          }
          // Store error info for non-streaming response
          if (!stream) {
            branchInfo = { error: error.message };
            prInfo = { error: error.message };
          }
        }
      }

      // Handle response based on streaming mode
      if (stream) {
        // Streaming mode: end the SSE stream
        writer.end();
      } else {
        // Non-streaming mode: send filtered messages and token summary as JSON
        const assistantMessages = writer.getAssistantMessages();
        const tokenSummary = writer.getTotalTokens();

        const response = {
          success: !aborted,
          ...(aborted ? { aborted: true } : {}),
          sessionId: appSessionId,
          // The provider-native id, for a caller that drives the CLI itself
          // (`claude --resume`); `sessionId` is what this API and the UI use.
          providerSessionId: run.writer.getSessionId(),
          messages: assistantMessages,
          tokens: tokenSummary,
          projectPath: finalProjectPath
        };

        // Add branch/PR info if created
        if (branchInfo) {
          response.branch = branchInfo;
        }
        if (prInfo) {
          response.pullRequest = prInfo;
        }

        res.json(response);
      }

      // Clean up if requested
      if (cleanup && repositoryUrl && clonedProjectCreated) {
        // Only cleanup if we cloned a repo (not for existing project paths)
        const sessionIdForCleanup = run.writer.getSessionId();
        setTimeout(() => {
          cleanupProject(finalProjectPath, sessionIdForCleanup);
        }, 5000);
      }

    } catch (error) {
      console.error('❌ External session error:', error);

      // Clean up on error
      if (finalProjectPath && cleanup && repositoryUrl && clonedProjectCreated) {
        const sessionIdForCleanup = run ? run.writer.getSessionId() : null;
        cleanupProject(finalProjectPath, sessionIdForCleanup);
      }

      if (stream) {
        // For streaming, send error event and stop
        if (!writer) {
          // Set up SSE headers if not already done
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          writer = new SSEStreamWriter(res);
        }

        if (!res.writableEnded) {
          writer.send({
            type: 'error',
            error: error.message,
            message: `Failed: ${error.message}`
          });
          writer.end();
        }
      } else if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    } finally {
      // Safety net, as for a chat send: a runtime that threw or resolved
      // without its terminal `complete` would leave the session listed as
      // running in every tab. Scoped to this run, so a run the session
      // started meanwhile is left alone.
      if (run) {
        runRegistry.completeRunIfCurrent(run, { exitCode: 1 });
      }
    }
  });

  return router;
}
