// REST v3: repos, branches, commits, contents, labels, issues, comments and
// pulls. Every reply is JSON with a non-empty X-GitHub-Request-Id (added by
// app.ts), every error body carries a string `message`, a repo under another
// owner is a 404 (never a 403), and a malformed JSON body is a 400.
//
// Shapes follow the public GitHub v3 shapes the suite reads: repo objects
// carry id/name/full_name/private/description/default_branch/owner, issues
// carry number/title/body/state/labels, pulls carry head/base refs and shas
// plus merged/merged_at/merge_commit_sha after a squash merge.

import { VIEWER, DEFAULT_BRANCH } from './scenario.ts';
import { Forge, ForgeError, globalId, type Issue, type Label, type Pull, type Repo } from './store.ts';
import { b64encode, b64decode, decodeSegment, trialNowIso } from './util.ts';
import type { HttpContext, HttpResponse } from './git.ts';
import { jsonResponse } from './git.ts';

function parseJsonBody(ctx: HttpContext): Record<string, unknown> {
  if (ctx.body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(ctx.body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new ForgeError(400, 'request body is not valid JSON');
  }
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pageParams(ctx: HttpContext): { perPage: number; page: number } {
  const perPage = Math.max(1, Math.min(100, parseInt(ctx.query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(ctx.query.get('page') ?? '1', 10) || 1);
  return { perPage, page };
}

function pageSlice<T>(items: T[], ctx: HttpContext): { items: T[]; link: string | undefined } {
  const { perPage, page } = pageParams(ctx);
  const start = (page - 1) * perPage;
  const sliced = items.slice(start, start + perPage);
  let link: string | undefined;
  if (start + perPage < items.length) {
    const host = ctx.headers['host'] ?? '127.0.0.1';
    const url = new URL(ctx.pathname, `http://${host}`);
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page + 1));
    for (const [key, value] of ctx.query) {
      if (key !== 'per_page' && key !== 'page') url.searchParams.set(key, value);
    }
    link = `<${url.toString()}>; rel="next"`;
  }
  return { items: sliced, link };
}

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: globalId('User', VIEWER.login),
    name: VIEWER.name,
    email: VIEWER.email,
    type: 'User',
    site_admin: false,
    html_url: `https://github.com/${VIEWER.login}`,
    url: `/api/v3/users/${VIEWER.login}`,
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
  };
}

function repoJson(repo: Repo): Record<string, unknown> {
  const openIssues = repo.issues.filter((issue) => issue.state === 'open').length;
  return {
    id: repo.id,
    node_id: globalId('Repository', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, node_id: globalId('User', repo.owner), type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
    pushed_at: trialNowIso(),
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    forks_count: 0,
    open_issues_count: openIssues,
    watchers_count: 0,
    stargazers_count: 0,
    size: 0,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('Label', `${label.name}`),
    name: label.name,
    color: label.color,
    default: false,
    description: '',
    url: `/api/v3/labels/${encodeURIComponent(label.name)}`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((label) => labelJson(label)),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/**
 * The serialized bytes of one issue, cached per issue. An issue's JSON
 * changes only when a field the serializer reads changes, so the cache key is
 * a fingerprint of exactly those fields (state, title, body, updatedAt,
 * closedAt, comment count, label ids — every mutation path in rest.ts,
 * store.ts and graphql.ts moves at least one of them). The bytes come from
 * the same serializer and the same JSON.stringify, so a cached reply is
 * byte-identical to a fresh one; the cache only skips rebuilding it.
 */
const issueBodyCache = new WeakMap<Issue, { fingerprint: string; body: Buffer }>();

function issueFingerprint(issue: Issue): string {
  let labels = '';
  for (const label of issue.labels) labels += `${label.id},`;
  return [
    issue.state,
    issue.title,
    issue.body,
    issue.updatedAt,
    issue.closedAt ?? '',
    String(issue.comments.length),
    labels,
  ].join('\u0000');
}

function issueBody(repo: Repo, issue: Issue): Buffer {
  const fingerprint = issueFingerprint(issue);
  const cached = issueBodyCache.get(issue);
  if (cached && cached.fingerprint === fingerprint) return cached.body;
  const body = Buffer.from(JSON.stringify(issueJson(repo, issue)), 'utf8');
  issueBodyCache.set(issue, { fingerprint, body });
  return body;
}

/** A JSON array of issue bodies, byte-identical to stringifying the objects. */
function issueArrayBody(repo: Repo, issues: Issue[]): Buffer {
  const parts: Buffer[] = [Buffer.from('[', 'utf8')];
  issues.forEach((issue, index) => {
    if (index > 0) parts.push(Buffer.from(',', 'utf8'));
    parts.push(issueBody(repo, issue));
  });
  parts.push(Buffer.from(']', 'utf8'));
  return Buffer.concat(parts);
}

function commentJson(repo: Repo, issue: Issue, comment: { id: number; body: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}#${comment.id}`),
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const base = {
    login: VIEWER.login,
    id: VIEWER.id,
    type: 'User',
  };
  const mergeable = pull.state === 'open' ? !forge.pullConflicts(repo, pull) : false;
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: base,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: base,
      repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: base,
      repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    merged: pull.merged,
    mergeable,
    mergeable_state: mergeable ? 'clean' : 'dirty',
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function requireRepo(forge: Forge, owner: string, name: string): Repo {
  const repo = forge.getRepo(owner, name);
  if (!repo) throw new ForgeError(404, 'Not Found');
  return repo;
}

export function handleRest(forge: Forge, ctx: HttpContext): HttpResponse {
  const segments = ctx.pathname.split('/').filter((part) => part.length > 0);
  // segments[0] is 'api', segments[1] is 'v3'.
  const rest = segments.slice(2);
  const method = ctx.method;

  // GET /api/v3/ — the API root.
  if (rest.length === 0) {
    if (method !== 'GET') return jsonResponse(404, { message: 'Not Found' });
    return jsonResponse(200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      meta: '/api/v3/meta',
    }, { 'x-oauth-scopes': 'repo, user' });
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return jsonResponse(404, { message: 'Not Found' });
    return jsonResponse(200, { installed_version: '1.0.0', verifiable_password_authentication: false });
  }

  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user' && method === 'GET') {
    return jsonResponse(200, userJson());
  }

  // /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const { items, link } = pageSlice(forge.listRepos(), ctx);
      const headers: Record<string, string> = {};
      if (link) headers['link'] = link;
      return jsonResponse(200, items.map((repo) => repoJson(repo)), headers);
    }
    if (method === 'POST') {
      const body = parseJsonBody(ctx);
      const name = asString(body['name']);
      if (!name) throw new ForgeError(422, 'name is required');
      const repo = forge.createRepo(name, asString(body['description']), asBoolean(body['private']));
      return jsonResponse(201, repoJson(repo));
    }
    return jsonResponse(404, { message: 'Not Found' });
  }

  // /api/v3/repos/{owner}/{repo}...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = decodeSegment(rest[1]);
    const name = decodeSegment(rest[2]);
    const tail = rest.slice(3);
    const repo = requireRepo(forge, owner, name);

    // The repo itself.
    if (tail.length === 0) {
      if (method === 'GET') return jsonResponse(200, repoJson(repo));
      if (method === 'PATCH') {
        const body = parseJsonBody(ctx);
        if (typeof body['description'] === 'string') repo.description = body['description'];
        if (typeof body['private'] === 'boolean') repo.isPrivate = body['private'];
        return jsonResponse(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        forge.deleteRepo(owner, name);
        return { status: 204, headers: {}, body: Buffer.alloc(0) };
      }
      return jsonResponse(404, { message: 'Not Found' });
    }

    // git refs: POST /git/refs, GET /git/refs/<ref...>
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const body = parseJsonBody(ctx);
        const ref = asString(body['ref']);
        const sha = asString(body['sha']);
        if (!ref.startsWith('refs/')) throw new ForgeError(422, 'ref must start with refs/');
        if (!/^[0-9a-f]{40}$/.test(sha)) throw new ForgeError(422, 'sha is not a valid object id');
        if (!forge.getObject(repo, sha)) throw new ForgeError(422, 'sha does not exist');
        if (repo.refs.has(ref)) throw new ForgeError(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        forge.clearPackCache(repo);
        return jsonResponse(201, { ref, object: { sha, type: 'commit' }, url: `/api/v3/repos/${owner}/${name}/git/refs/${ref}` });
      }
      if (method === 'GET' && tail.length > 2) {
        const refPath = tail.slice(2).map((part) => decodeURIComponent(part)).join('/');
        const ref = refPath.startsWith('refs/') ? refPath : `refs/${refPath}`;
        const sha = repo.refs.get(ref);
        if (!sha) throw new ForgeError(404, 'Not Found');
        return jsonResponse(200, { ref, object: { sha, type: 'commit' }, url: `/api/v3/repos/${owner}/${name}/git/refs/${ref}` });
      }
      return jsonResponse(404, { message: 'Not Found' });
    }

    // branches
    if (tail[0] === 'branches') {
      if (method === 'GET' && tail.length === 1) {
        const branches = forge.listBranches(repo).map((branch) => ({
          name: branch.name,
          commit: { sha: branch.sha, url: `/api/v3/repos/${owner}/${name}/commits/${branch.sha}` },
          protected: false,
        }));
        return jsonResponse(200, branches);
      }
      if (method === 'GET' && tail.length === 2) {
        const branch = decodeURIComponent(tail[1]);
        const sha = forge.branchTip(repo, branch);
        if (!sha) throw new ForgeError(404, 'Not Found');
        return jsonResponse(200, {
          name: branch,
          commit: { sha, url: `/api/v3/repos/${owner}/${name}/commits/${sha}` },
          protected: false,
        });
      }
      return jsonResponse(404, { message: 'Not Found' });
    }

    // commits
    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
      const ref = ctx.query.get('sha') ?? repo.defaultBranch;
      const commits = forge.listCommits(repo, ref).map((commit) => ({
        sha: commit.sha,
        commit: {
          message: commit.message,
          author: { name: VIEWER.name, email: VIEWER.email, date: trialNowIso() },
          committer: { name: VIEWER.name, email: VIEWER.email, date: trialNowIso() },
        },
        author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
        committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
        parents: [],
        url: `/api/v3/repos/${owner}/${name}/commits/${commit.sha}`,
      }));
      return jsonResponse(200, commits);
    }

    // contents
    if (tail[0] === 'contents') {
      const path = tail.slice(1).map((part) => decodeURIComponent(part)).join('/');
      if (method === 'GET') {
        const ref = ctx.query.get('ref') ?? undefined;
        const result = forge.getContents(repo, ref, path);
        if (result.kind === 'file') {
          return jsonResponse(200, {
            type: 'file',
            encoding: 'base64',
            size: result.size,
            name: path.split('/').pop() ?? path,
            path,
            content: b64encode(result.content),
            sha: result.sha,
            url: `/api/v3/repos/${owner}/${name}/contents/${path}`,
          });
        }
        return jsonResponse(200, result.entries.map((entry) => ({
          type: entry.type,
          size: entry.size,
          name: entry.name,
          path: entry.path,
          sha: entry.sha,
          url: `/api/v3/repos/${owner}/${name}/contents/${entry.path}`,
        })));
      }
      if (method === 'PUT') {
        const body = parseJsonBody(ctx);
        const message = asString(body['message'], 'Update file');
        const contentText = asString(body['content']);
        if (!contentText) throw new ForgeError(422, 'content is required');
        const branch = asString(body['branch'], repo.defaultBranch);
        const sha = typeof body['sha'] === 'string' ? (body['sha'] as string) : undefined;
        const result = forge.putContents(repo, branch, path, b64decode(contentText), message, sha);
        const name = path.split('/').pop() ?? path;
        return jsonResponse(result.created ? 201 : 200, {
          content: {
            name,
            path,
            sha: result.blobSha,
            size: b64decode(contentText).length,
            type: 'file',
            encoding: 'base64',
            content: contentText,
            url: `/api/v3/repos/${owner}/${name}/contents/${path}`,
          },
          commit: { sha: result.commitSha, message },
        });
      }
      if (method === 'DELETE') {
        const body = parseJsonBody(ctx);
        const message = asString(body['message'], 'Delete file');
        const branch = asString(body['branch'], repo.defaultBranch);
        const sha = typeof body['sha'] === 'string' ? (body['sha'] as string) : undefined;
        const commitSha = forge.deleteContents(repo, branch, path, message, sha);
        return jsonResponse(200, { commit: { sha: commitSha, message } });
      }
      return jsonResponse(404, { message: 'Not Found' });
    }

    // labels
    if (tail[0] === 'labels') {
      if (method === 'GET' && tail.length === 1) {
        return jsonResponse(200, [...repo.labels.values()].map((label) => labelJson(label)));
      }
      if (method === 'POST' && tail.length === 1) {
        const body = parseJsonBody(ctx);
        const labelName = asString(body['name']);
        if (!labelName) throw new ForgeError(422, 'name is required');
        const label = forge.createLabel(repo, labelName, asString(body['color'], 'ededed'));
        return jsonResponse(201, labelJson(label));
      }
      return jsonResponse(404, { message: 'Not Found' });
    }

    // issues
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const direction = ctx.query.get('direction') ?? 'desc';
          const listed = forge.listIssues(repo, state, direction);
          const { items, link } = pageSlice(listed, ctx);
          const headers: Record<string, string> = {};
          if (link) headers['link'] = link;
          return { status: 200, headers: { 'content-type': 'application/json', ...headers }, body: issueArrayBody(repo, items) };
        }
        if (method === 'POST') {
          const body = parseJsonBody(ctx);
          const title = asString(body['title']);
          if (!title) throw new ForgeError(422, 'title is required');
          const bodyText = asString(body['body']);
          const labelNames = Array.isArray(body['labels'])
            ? (body['labels'] as unknown[]).filter((item): item is string => typeof item === 'string')
            : [];
          const issue = forge.createIssue(repo, title, bodyText, labelNames);
          return { status: 201, headers: { 'content-type': 'application/json' }, body: issueBody(repo, issue) };
        }
        return jsonResponse(404, { message: 'Not Found' });
      }
      const issueNumber = parseInt(tail[1], 10);
      if (!Number.isSafeInteger(issueNumber)) return jsonResponse(404, { message: 'Not Found' });
      const issue = forge.getIssue(repo, issueNumber);
      if (!issue) throw new ForgeError(404, 'Not Found');
      if (tail.length === 2) {
        if (method === 'GET') return { status: 200, headers: { 'content-type': 'application/json' }, body: issueBody(repo, issue) };
        if (method === 'PATCH') {
          const body = parseJsonBody(ctx);
          if (body['state'] === 'closed' || body['state'] === 'open') {
            issue.state = body['state'] as 'open' | 'closed';
            issue.closedAt = issue.state === 'closed' ? trialNowIso() : null;
          }
          if (typeof body['title'] === 'string') issue.title = body['title'];
          if (typeof body['body'] === 'string') issue.body = body['body'];
          issue.updatedAt = trialNowIso();
          return { status: 200, headers: { 'content-type': 'application/json' }, body: issueBody(repo, issue) };
        }
        return jsonResponse(404, { message: 'Not Found' });
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (method === 'GET') {
          return jsonResponse(200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
        }
        if (method === 'POST') {
          const body = parseJsonBody(ctx);
          const commentBody = asString(body['body']);
          if (!commentBody) throw new ForgeError(422, 'body is required');
          const comment = forge.addComment(repo, issueNumber, commentBody);
          return jsonResponse(201, commentJson(repo, issue, comment));
        }
        return jsonResponse(404, { message: 'Not Found' });
      }
      return jsonResponse(404, { message: 'Not Found' });
    }

    // pulls
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const listed = forge.listPulls(repo, state);
          const { items, link } = pageSlice(listed, ctx);
          const headers: Record<string, string> = {};
          if (link) headers['link'] = link;
          return jsonResponse(200, items.map((pull) => pullJson(forge, repo, pull)), headers);
        }
        if (method === 'POST') {
          const body = parseJsonBody(ctx);
          const title = asString(body['title']);
          const head = asString(body['head']);
          const base = asString(body['base']);
          if (!title || !head || !base) throw new ForgeError(422, 'title, head and base are required');
          const pull = forge.createPull(repo, title, asString(body['body']), head, base);
          return jsonResponse(201, pullJson(forge, repo, pull));
        }
        return jsonResponse(404, { message: 'Not Found' });
      }
      const pullNumber = parseInt(tail[1], 10);
      if (!Number.isSafeInteger(pullNumber)) return jsonResponse(404, { message: 'Not Found' });
      const pull = forge.getPull(repo, pullNumber);
      if (!pull) throw new ForgeError(404, 'Not Found');
      if (tail.length === 2 && method === 'GET') {
        return jsonResponse(200, pullJson(forge, repo, pull));
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        const files = forge.pullFiles(repo, pull).map((file) => ({
          sha: '',
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          blob_url: '',
          raw_url: '',
          contents_url: '',
        }));
        return jsonResponse(200, files);
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        parseJsonBody(ctx);
        const mergeSha = forge.mergePull(repo, pull);
        return jsonResponse(200, { merged: true, sha: mergeSha, message: `${pull.title} (#${pull.number})` });
      }
      return jsonResponse(404, { message: 'Not Found' });
    }

    return jsonResponse(404, { message: 'Not Found' });
  }

  return jsonResponse(404, { message: 'Not Found' });
}
