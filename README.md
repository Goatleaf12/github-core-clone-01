# github-core-clone-01

A GitHub-compatible git forge in a single Node 22 process, standard library
only — no git binary, no database, no outbound network. Built as an entry for
the make.fun bounty **github-core-clone-01** ($500).

## What it serves

- **REST v3** (`/api/v3/...`): repos, branches, commits, contents, labels,
  issues, comments and pull requests (including squash merge with 3-way
  conflict detection).
- **Git smart HTTP** (`/<owner>/<repo>.git/...`): upload-pack protocol v2
  (advertisement, ls-refs, fetch with shallow/deepen) and v0 (advertisement,
  fetch), plus receive-pack v0 with report-status, side-band-64k and
  delete-refs. Packs are built on the fly and cached per head sha.
- **GraphQL v4** (`/api/graphql`): viewer, repository, issues, pull requests,
  node, `__type` introspection, and the createIssue / closeIssue /
  createPullRequest / mergePullRequest / addComment mutations. Batches too.
- **MCP** (`/mcp`): JSON-RPC 2.0 Streamable HTTP, both the modern
  `server/discover` era (protocol revision 2026-07-28) and the legacy
  `initialize` handshake, with six tools: create_repo, get_repo,
  create_issue, list_issues, create_pull_request, merge_pull_request.

## Layout

| File | What it holds |
| --- | --- |
| `main.ts` | The entry ↔ env lifecycle: bind, register, poll /done, exit 0. |
| `app.ts` | The HTTP server, auth, request ids, routing. |
| `store.ts` | All state: repos, git objects, issues, pulls, packs. |
| `git.ts` | pkt-lines, pack reading/writing, smart HTTP handlers. |
| `rest.ts` | REST v3 handlers. |
| `graphql.ts` | A small GraphQL parser + executor for the suite's documents. |
| `mcp.ts` | MCP JSON-RPC handlers and tools. |
| `scenario.ts` | The public scenario seed; derives the viewer login from it. |
| `util.ts` | sha1, zlib, base64, the deterministic clock. |

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 \
MAKEFUN_SHOP_TOKEN=shpat_test \
node --experimental-strip-types main.ts
```

The server binds an ephemeral port, registers it with the env, and waits for
the env to say done. `GET /healthz` answers `{"ok":true}` without a token;
every other route needs `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.

## Determinism

No clocks, no randomness, no uuids anywhere in a reply: timestamps come from
`MAKEFUN_TRIAL_NOW` (or a fixed constant), `X-GitHub-Request-Id` comes from
a counter, and ids are assigned in creation order. The viewer login is
derived at runtime from the public scenario seed, never from the token.
