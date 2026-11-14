// MCP: JSON-RPC 2.0 over Streamable HTTP at POST /mcp. Both eras are served:
// the modern one (server/discover, protocol revision 2026-07-28) and the
// legacy handshake (initialize + notifications/initialized). Tools are the
// six forge operations the suite needs, and the tools/list array is one
// frozen constant, so repeated calls return byte-identical JSON.
//
// Rules the suite pins down:
//  - No Authorization is a 401, checked before any tool exists.
//  - A non-JSON body is HTTP 400 with JSON-RPC error -32700.
//  - An unknown tool is a JSON-RPC error (-32601), never HTTP 500.
//  - Missing required arguments are an isError:true tool result.
//  - Concurrent calls echo their own JSON-RPC id and name their own repo.

import { Forge, ForgeError, type Repo } from './store.ts';
import type { HttpContext, HttpResponse } from './git.ts';
import { jsonResponse } from './git.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSION = '2025-11-25';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** The tools/list payload, serialized once so every call is byte-identical. */
const TOOLS_LIST_JSON = JSON.stringify({ tools: TOOLS });

function toolResult(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    content: [{ type: 'text', text }],
    structuredContent: value,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function missingArg(args: Record<string, unknown>, name: string): boolean {
  return args[name] === undefined || args[name] === null || args[name] === '';
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueJson(repo: Repo, issue: ReturnType<Forge['createIssue']>): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: ReturnType<Forge['createPull']>): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** Split `owner`/`repo` (or a `full_name` of "owner/repo") into their parts. */
function ownerAndRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  const fullName = typeof args['full_name'] === 'string' ? (args['full_name'] as string) : '';
  if (fullName.includes('/')) {
    const [owner, repo] = fullName.split('/');
    return { owner, repo };
  }
  return {
    owner: typeof args['owner'] === 'string' ? (args['owner'] as string) : '',
    repo: typeof args['repo'] === 'string' ? (args['repo'] as string) : '',
  };
}

function runTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((item) => item.name === name);
  if (!tool) throw new ForgeError(-32601, `Method not found: ${name}`);
  for (const required of tool.inputSchema.required) {
    // pull_number may also arrive as `number`.
    if (required === 'pull_number' && (args['number'] !== undefined || args['pullNumber'] !== undefined)) continue;
    if (missingArg(args, required)) return toolError(`missing required argument: ${required}`);
  }

  if (name === 'create_repo') {
    const repoName = String(args['name']);
    const repo = forge.createRepo(repoName, typeof args['description'] === 'string' ? (args['description'] as string) : '', args['private'] === true);
    return toolResult(repoJson(repo));
  }

  const { owner, repo: repoName } = ownerAndRepo(args);
  const repo = forge.getRepo(owner, repoName);
  if (!repo) throw new ForgeError(-32602, `repository not found: ${owner}/${repoName}`);

  if (name === 'get_repo') {
    return toolResult(repoJson(repo));
  }
  if (name === 'create_issue') {
    const issue = forge.createIssue(repo, String(args['title']), typeof args['body'] === 'string' ? (args['body'] as string) : '', []);
    return toolResult(issueJson(repo, issue));
  }
  if (name === 'list_issues') {
    const state = typeof args['state'] === 'string' ? (args['state'] as string) : 'open';
    const direction = 'desc';
    const issues = forge.listIssues(repo, state, direction);
    return toolResult(issues.map((issue) => issueJson(repo, issue)));
  }
  if (name === 'create_pull_request') {
    const pull = forge.createPull(
      repo,
      String(args['title']),
      typeof args['body'] === 'string' ? (args['body'] as string) : '',
      String(args['head']),
      String(args['base']),
    );
    return toolResult(pullJson(repo, pull));
  }
  if (name === 'merge_pull_request') {
    const number = Number(args['pull_number'] ?? args['number'] ?? args['pullNumber'] ?? 0);
    const pull = forge.getPull(repo, number);
    if (!pull) throw new ForgeError(-32602, `pull request not found: ${number}`);
    const mergeSha = forge.mergePull(repo, pull);
    return toolResult({ merged: true, number: pull.number, sha: mergeSha });
  }
  throw new ForgeError(-32601, `Method not found: ${name}`);
}

function rpcResult(id: unknown, result: unknown): HttpResponse {
  return jsonResponse(200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string): HttpResponse {
  return jsonResponse(200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

export function handleMcp(forge: Forge, ctx: HttpContext): HttpResponse {
  let body: unknown;
  try {
    body = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return jsonResponse(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }
  const request = body as Record<string, unknown>;
  const id = request['id'] ?? null;
  const method = typeof request['method'] === 'string' ? (request['method'] as string) : '';
  const params = (request['params'] ?? {}) as Record<string, unknown>;

  // A notification has no id: answer 202 with an empty body.
  const isNotification = id === null || id === undefined;

  if (method === 'notifications/initialized') {
    return { status: 202, headers: {}, body: Buffer.alloc(0) };
  }
  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return rpcResult(id, {
      supportedVersions: [MODERN_VERSION, LEGACY_VERSION],
      capabilities: { tools: { listChanged: false } },
      serverInfo,
      instructions: 'A GitHub-compatible git forge: repos, issues, pull requests, git smart HTTP, GraphQL and MCP tools.',
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : '';
    const protocolVersion = requested === MODERN_VERSION || requested === LEGACY_VERSION ? requested : LEGACY_VERSION;
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    // Return the pre-serialized constant through a parse so the bytes match
    // every time, whatever the caller asked for.
    const parsed: unknown = JSON.parse(TOOLS_LIST_JSON);
    return rpcResult(id, parsed);
  }
  if (method === 'tools/call') {
    const toolName = typeof params['name'] === 'string' ? (params['name'] as string) : '';
    const args = (params['arguments'] ?? {}) as Record<string, unknown>;
    try {
      const result = runTool(forge, toolName, args);
      return rpcResult(id, result);
    } catch (err) {
      if (err instanceof ForgeError && err.status < 0) {
        return rpcError(id, err.status, err.message);
      }
      if (err instanceof ForgeError) {
        return rpcResult(id, toolError(err.message));
      }
      return rpcError(id, -32603, err instanceof Error ? err.message : 'Internal error');
    }
  }
  if (isNotification) {
    return { status: 202, headers: {}, body: Buffer.alloc(0) };
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}
