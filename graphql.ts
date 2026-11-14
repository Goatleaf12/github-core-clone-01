// GraphQL v4: a small hand-written parser and executor for exactly the
// documents the suite sends. No general GraphQL engine is needed: the
// operations are fixed (viewer, repository, issues, pullRequests, node,
// __type introspection, and five mutations), so the parser handles queries,
// mutations, variables, aliases, inline fragments, enums, lists and input
// objects, and the executor validates every field against a static schema.
//
// Rules the suite pins down:
//  - No token is exactly 401; an unknown repo is `data.repository = null`
//    with no errors; an unknown field is HTTP 200 with an `errors` entry
//    naming the field.
//  - A batch body is a JSON array of operations, answered as an array in
//    order.
//  - Global ids are opaque (base64url of `Type:key`), stable across reads,
//    and decodable by the server for mutations.

import { VIEWER, DEFAULT_BRANCH } from './scenario.ts';
import { Forge, ForgeError, globalId, type Issue, type Pull, type Repo } from './store.ts';
import { b64urlEncode, b64urlDecode, trialNowIso } from './util.ts';
import type { HttpContext, HttpResponse } from './git.ts';
import { jsonResponse } from './git.ts';

// ---------------------------------------------------------------- schema tables

/** The fields each object type exposes, for execution and introspection. */
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
    'createdAt', 'updatedAt', 'url',
  ],
  Ref: ['id', 'name', 'prefix', 'target'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'commits', 'url', 'createdAt', 'updatedAt', 'author',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'url', 'createdAt', 'updatedAt', 'author'],
  IssueCommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['queryType', 'mutationType', 'subscriptionType', 'types', 'directives'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'REGISTRY_PACKAGE', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

const TYPE_KIND: Record<string, string> = {
  Query: 'OBJECT',
  Mutation: 'OBJECT',
  User: 'OBJECT',
  Repository: 'OBJECT',
  Ref: 'OBJECT',
  Issue: 'OBJECT',
  IssueConnection: 'OBJECT',
  IssueEdge: 'OBJECT',
  PageInfo: 'OBJECT',
  PullRequest: 'OBJECT',
  PullRequestConnection: 'OBJECT',
  PullRequestEdge: 'OBJECT',
  PullRequestChangedFileConnection: 'OBJECT',
  PullRequestChangedFile: 'OBJECT',
  IssueComment: 'OBJECT',
  IssueCommentEdge: 'OBJECT',
  CreateIssuePayload: 'OBJECT',
  CloseIssuePayload: 'OBJECT',
  CreatePullRequestPayload: 'OBJECT',
  MergePullRequestPayload: 'OBJECT',
  AddCommentPayload: 'OBJECT',
  __Type: 'OBJECT',
  __Field: 'OBJECT',
  __EnumValue: 'OBJECT',
  __Schema: 'OBJECT',
};

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'variable'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const escaped = source[i + 1];
          if (escaped === 'n') value += '\n';
          else if (escaped === 't') value += '\t';
          else if (escaped === 'r') value += '\r';
          else value += escaped;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '$') {
      let name = '';
      i += 1;
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) {
        name += source[i];
        i += 1;
      }
      tokens.push({ kind: 'variable', value: name });
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(source[i + 1] ?? ''))) {
      let num = '';
      while (i < source.length && /[0-9.eE+-]/.test(source[i])) {
        num += source[i];
        i += 1;
      }
      tokens.push({ kind: 'int', value: parseInt(num, 10) });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let name = '';
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) {
        name += source[i];
        i += 1;
      }
      tokens.push({ kind: 'name', value: name });
      continue;
    }
    throw new ForgeError(400, `unexpected character in GraphQL document: ${ch}`);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

interface GqlField {
  alias: string | undefined;
  name: string;
  args: Array<{ name: string; value: GqlValue }>;
  selections: GqlSelection[];
}

type GqlSelection =
  | { kind: 'field'; field: GqlField }
  | { kind: 'fragment'; typeCondition: string | undefined; selections: GqlSelection[] };

interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | undefined;
  selections: GqlSelection[];
}

class Parser {
  tokens: Token[];
  pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new ForgeError(400, 'unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new ForgeError(400, `expected ${value} in GraphQL document`);
  }

  acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): GqlOperation {
    // Skip an optional operation header; take the first operation.
    let kind: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    const first = this.peek();
    if (first && first.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      kind = first.value;
      this.pos += 1;
      const maybeName = this.peek();
      if (maybeName && maybeName.kind === 'name') {
        name = maybeName.value;
        this.pos += 1;
      }
      // Skip variable definitions `( $x: Type = default, ... )`.
      if (this.acceptPunct('(')) {
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          else if (token.kind === 'punct' && token.value === ')') depth -= 1;
        }
      }
    }
    const selections = this.parseSelectionSet();
    return { kind, name, selections };
  }

  parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (true) {
      const token = this.peek();
      if (!token) throw new ForgeError(400, 'unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.pos += 1;
        break;
      }
      selections.push(this.parseSelection());
    }
    return selections;
  }

  parseSelection(): GqlSelection {
    const token = this.peek();
    if (token && token.kind === 'punct' && token.value === '...') {
      this.pos += 1;
      let typeCondition: string | undefined;
      const next = this.peek();
      if (next && next.kind === 'name' && next.value === 'on') {
        this.pos += 1;
        const typeToken = this.next();
        if (typeToken.kind !== 'name') throw new ForgeError(400, 'expected a type name after on');
        typeCondition = typeToken.value;
      }
      // Fragment spreads (`...Name`) are not used by the suite; skip them.
      if (typeCondition === undefined) {
        const nameToken = this.peek();
        if (nameToken && nameToken.kind === 'name') this.pos += 1;
      }
      const selections = this.parseSelectionSet();
      return { kind: 'fragment', typeCondition, selections };
    }
    return { kind: 'field', field: this.parseField() };
  }

  parseField(): GqlField {
    const first = this.next();
    if (first.kind !== 'name') throw new ForgeError(400, 'expected a field name');
    let alias: string | undefined;
    let name = first.value;
    if (this.acceptPunct(':')) {
      alias = name;
      const real = this.next();
      if (real.kind !== 'name') throw new ForgeError(400, 'expected a field name after an alias');
      name = real.value;
    }
    const args: Array<{ name: string; value: GqlValue }> = [];
    if (this.acceptPunct('(')) {
      while (true) {
        const token = this.peek();
        if (!token) throw new ForgeError(400, 'unterminated argument list');
        if (token.kind === 'punct' && token.value === ')') {
          this.pos += 1;
          break;
        }
        const argName = this.next();
        if (argName.kind !== 'name') throw new ForgeError(400, 'expected an argument name');
        this.expectPunct(':');
        args.push({ name: argName.value, value: this.parseValue() });
      }
    }
    // Skip directives (@...) if any appear.
    while (this.acceptPunct('@')) {
      const directive = this.next();
      void directive;
      if (this.acceptPunct('(')) {
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          else if (token.kind === 'punct' && token.value === ')') depth -= 1;
        }
      }
    }
    const next = this.peek();
    const selections = next && next.kind === 'punct' && next.value === '{' ? this.parseSelectionSet() : [];
    return { alias, name, args, selections };
  }

  parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'variable') return { kind: 'var', name: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: GqlValue[] = [];
      while (true) {
        const next = this.peek();
        if (!next) throw new ForgeError(400, 'unterminated list');
        if (next.kind === 'punct' && next.value === ']') {
          this.pos += 1;
          break;
        }
        values.push(this.parseValue());
      }
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (true) {
        const next = this.peek();
        if (!next) throw new ForgeError(400, 'unterminated input object');
        if (next.kind === 'punct' && next.value === '}') {
          this.pos += 1;
          break;
        }
        const fieldName = this.next();
        if (fieldName.kind !== 'name') throw new ForgeError(400, 'expected a field name in an input object');
        this.expectPunct(':');
        fields.push({ name: fieldName.value, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    throw new ForgeError(400, 'unexpected value in GraphQL document');
  }
}

// ---------------------------------------------------------------- values

function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name] ?? null;
    case 'int':
      return value.value;
    case 'string':
      return value.value;
    case 'bool':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArgs(field: GqlField, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------- executor
//
// executeField returns RAW values (a scalar, null, a GqlObject, or an array
// of them); applySelections then runs the field's sub-selections over any
// object it finds. That keeps introspection lists and connection nodes from
// leaking internal `__`-prefixed keys into the reply.

interface GqlObject {
  __type: string;
  [key: string]: unknown;
}

interface ExecutorContext {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function fieldTypeName(typeName: string, fieldName: string): string | undefined {
  const fields = TYPE_FIELDS[typeName];
  if (!fields) return undefined;
  return fields.includes(fieldName) ? typeName : undefined;
}

function executeSelections(
  ctx: ExecutorContext,
  parentType: string,
  parent: GqlObject | null,
  selections: GqlSelection[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition && parent && parent.__type !== selection.typeCondition) continue;
      const nested = executeSelections(ctx, selection.typeCondition ?? parentType, parent, selection.selections);
      Object.assign(out, nested);
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = parentType;
      continue;
    }
    if (!fieldTypeName(parentType, field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
      continue;
    }
    out[key] = applySelections(ctx, executeField(ctx, parentType, parent, field), field.selections);
  }
  return out;
}

function applySelections(ctx: ExecutorContext, value: unknown, selections: GqlSelection[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => applySelections(ctx, item, selections));
  }
  if (value && typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
    const obj = value as GqlObject;
    if (selections.length === 0) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(obj)) {
        if (!key.startsWith('__') && typeof item !== 'object') out[key] = item;
      }
      return out;
    }
    return executeSelections(ctx, obj.__type, obj, selections);
  }
  return value;
}

function executeField(
  ctx: ExecutorContext,
  parentType: string,
  parent: GqlObject | null,
  field: GqlField,
): unknown {
  const args = resolveArgs(field, ctx.variables);
  const forge = ctx.forge;

  if (parentType === 'Query') {
    if (field.name === 'viewer') {
      return { __type: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
    }
    if (field.name === 'repository') {
      const owner = String(args['owner'] ?? '');
      const name = String(args['name'] ?? '');
      const repo = forge.getRepo(owner, name);
      if (!repo) return null;
      return repositoryObject(repo);
    }
    if (field.name === 'node') {
      return decodeNode(forge, String(args['id'] ?? ''));
    }
    if (field.name === '__type') {
      return typeObject(String(args['name'] ?? ''));
    }
    if (field.name === '__schema') {
      return { __type: '__Schema' };
    }
    return null;
  }

  if (parentType === 'Mutation') {
    if (field.name === 'createIssue') {
      const input = (args['input'] ?? {}) as Record<string, unknown>;
      const repo = decodeRepositoryId(forge, String(input['repositoryId'] ?? ''));
      if (!repo) return { __type: 'CreateIssuePayload', issue: null };
      const issue = forge.createIssue(repo, String(input['title'] ?? ''), String(input['body'] ?? ''), []);
      return { __type: 'CreateIssuePayload', issue: issueObject(repo, issue) };
    }
    if (field.name === 'closeIssue') {
      const input = (args['input'] ?? {}) as Record<string, unknown>;
      const decoded = decodeIssueId(forge, String(input['issueId'] ?? ''));
      if (!decoded) return { __type: 'CloseIssuePayload', issue: null };
      const { repo, issue } = decoded;
      issue.state = 'closed';
      issue.closedAt = trialNowIso();
      issue.updatedAt = trialNowIso();
      return { __type: 'CloseIssuePayload', issue: issueObject(repo, issue) };
    }
    if (field.name === 'createPullRequest') {
      const input = (args['input'] ?? {}) as Record<string, unknown>;
      const repo = decodeRepositoryId(forge, String(input['repositoryId'] ?? ''));
      if (!repo) return { __type: 'CreatePullRequestPayload', pullRequest: null };
      try {
        const pull = forge.createPull(repo, String(input['title'] ?? ''), '', String(input['headRefName'] ?? ''), String(input['baseRefName'] ?? ''));
        return { __type: 'CreatePullRequestPayload', pullRequest: pullRequestObject(repo, pull) };
      } catch {
        ctx.errors.push({ message: 'a pull request from this branch is already open' });
        return { __type: 'CreatePullRequestPayload', pullRequest: null };
      }
    }
    if (field.name === 'mergePullRequest') {
      const input = (args['input'] ?? {}) as Record<string, unknown>;
      const decoded = decodePullRequestId(forge, String(input['pullRequestId'] ?? ''));
      if (!decoded) return { __type: 'MergePullRequestPayload', pullRequest: null };
      const { repo, pull } = decoded;
      try {
        forge.mergePull(repo, pull);
      } catch (err) {
        ctx.errors.push({ message: err instanceof Error ? err.message : 'merge failed' });
      }
      return { __type: 'MergePullRequestPayload', pullRequest: pullRequestObject(repo, pull) };
    }
    if (field.name === 'addComment') {
      const input = (args['input'] ?? {}) as Record<string, unknown>;
      const decoded = decodeIssueId(forge, String(input['subjectId'] ?? ''));
      if (!decoded) return { __type: 'AddCommentPayload', commentEdge: null };
      const { repo, issue } = decoded;
      const comment = forge.addComment(repo, issue.number, String(input['body'] ?? ''));
      const edge: GqlObject = {
        __type: 'IssueCommentEdge',
        node: { __type: 'IssueComment', id: globalId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}#${comment.id}`), body: comment.body },
      };
      return { __type: 'AddCommentPayload', commentEdge: edge };
    }
    return null;
  }

  if (!parent) return null;

  if (parentType === 'User') {
    if (field.name === 'login') return parent['login'];
    if (field.name === 'id') return globalId('User', String(parent['login'] ?? ''));
    if (field.name === 'name') return parent['name'];
    if (field.name === 'email') return parent['email'];
    if (field.name === 'url') return `https://github.com/${String(parent['login'] ?? '')}`;
    return null;
  }

  if (parentType === 'Repository') {
    const repo = parent['__repo'] as Repo;
    if (field.name === 'id') return parent['id'];
    if (field.name === 'databaseId') return repo.id;
    if (field.name === 'name') return repo.name;
    if (field.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (field.name === 'owner') {
      return { __type: 'User', login: repo.owner, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
    }
    if (field.name === 'defaultBranchRef') {
      return { __type: 'Ref', name: repo.defaultBranch };
    }
    if (field.name === 'viewerPermission') return 'ADMIN';
    if (field.name === 'hasIssuesEnabled') return true;
    if (field.name === 'description') return repo.description;
    if (field.name === 'isPrivate') return repo.isPrivate;
    if (field.name === 'createdAt' || field.name === 'updatedAt') return trialNowIso();
    if (field.name === 'url') return `https://github.com/${repo.owner}/${repo.name}`;
    if (field.name === 'issue') {
      const number = Number(args['number'] ?? 0);
      const issue = forge.getIssue(repo, number);
      if (!issue) return null;
      return issueObject(repo, issue);
    }
    if (field.name === 'issues') {
      const first = Number(args['first'] ?? 10);
      const after = typeof args['after'] === 'string' ? args['after'] : undefined;
      const states = Array.isArray(args['states']) ? (args['states'] as unknown[]).map(String) : undefined;
      const nodes = issueNodes(repo, first, after, states, args['orderBy']);
      const pageInfo = issuePageInfo(repo, first, after, states);
      return { __type: 'IssueConnection', __nodes: nodes, __pageInfo: pageInfo };
    }
    if (field.name === 'pullRequests') {
      const first = Number(args['first'] ?? 10);
      const pulls = forge.listPulls(repo, 'all').slice(0, first);
      return { __type: 'PullRequestConnection', __nodes: pulls.map((pull) => pullRequestObject(repo, pull)) };
    }
    if (field.name === 'pullRequest') {
      const number = Number(args['number'] ?? 0);
      const pull = forge.getPull(repo, number);
      if (!pull) return null;
      return pullRequestObject(repo, pull);
    }
    return null;
  }

  if (parentType === 'Ref') {
    if (field.name === 'name') return parent['name'];
    if (field.name === 'id') return globalId('Ref', String(parent['name'] ?? ''));
    if (field.name === 'prefix') return 'refs/heads/';
    return null;
  }

  if (parentType === 'Issue') {
    const issue = parent['__issue'] as Issue;
    if (field.name === 'id') return parent['id'];
    if (field.name === 'number') return issue.number;
    if (field.name === 'title') return issue.title;
    if (field.name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    if (field.name === 'body') return issue.body;
    if (field.name === 'url') return `https://github.com/${parent['__owner']}/${parent['__repoName']}/issues/${issue.number}`;
    if (field.name === 'createdAt') return issue.createdAt;
    if (field.name === 'updatedAt') return issue.updatedAt;
    return null;
  }

  if (parentType === 'IssueConnection' || parentType === 'PullRequestConnection' || parentType === 'PullRequestChangedFileConnection') {
    if (field.name === 'nodes') return (parent['__nodes'] ?? []) as GqlObject[];
    if (field.name === 'edges') {
      const nodes = (parent['__nodes'] ?? []) as GqlObject[];
      const edgeType = parentType === 'IssueConnection' ? 'IssueEdge' : 'PullRequestEdge';
      return nodes.map((node) => ({ __type: edgeType, node }));
    }
    if (field.name === 'pageInfo') {
      return (parent['__pageInfo'] ?? { __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }) as GqlObject;
    }
    if (field.name === 'totalCount') return ((parent['__nodes'] ?? []) as unknown[]).length;
    return null;
  }

  if (parentType === 'IssueEdge' || parentType === 'PullRequestEdge') {
    if (field.name === 'node') return parent['node'];
    if (field.name === 'cursor') return '';
    return null;
  }

  if (parentType === 'PageInfo') {
    if (field.name === 'hasNextPage') return parent['hasNextPage'] ?? false;
    if (field.name === 'hasPreviousPage') return parent['hasPreviousPage'] ?? false;
    if (field.name === 'startCursor') return parent['startCursor'] ?? null;
    if (field.name === 'endCursor') return parent['endCursor'] ?? null;
    return null;
  }

  if (parentType === 'PullRequest') {
    const pull = parent['__pull'] as Pull;
    if (field.name === 'id') return parent['id'];
    if (field.name === 'number') return pull.number;
    if (field.name === 'title') return pull.title;
    if (field.name === 'body') return pull.body;
    if (field.name === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    if (field.name === 'merged') return pull.merged;
    if (field.name === 'mergeable') {
      const repo = parent['__repo'] as Repo;
      return forge.pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    }
    if (field.name === 'headRefName') return pull.headRef;
    if (field.name === 'baseRefName') return pull.baseRef;
    if (field.name === 'url') return `https://github.com/${parent['__owner']}/${parent['__repoName']}/pull/${pull.number}`;
    if (field.name === 'createdAt') return pull.createdAt;
    if (field.name === 'updatedAt') return pull.updatedAt;
    if (field.name === 'files') {
      const repo = parent['__repo'] as Repo;
      const first = Number(args['first'] ?? 10);
      const files = forge.pullFiles(repo, pull).slice(0, first);
      const nodes: GqlObject[] = files.map((file) => ({ __type: 'PullRequestChangedFile', path: file.filename }));
      return { __type: 'PullRequestChangedFileConnection', __nodes: nodes };
    }
    return null;
  }

  if (parentType === 'PullRequestChangedFile') {
    if (field.name === 'path') return parent['path'];
    if (field.name === 'additions') return 1;
    if (field.name === 'deletions') return 0;
    if (field.name === 'changeType') return 'MODIFIED';
    return null;
  }

  if (parentType === 'IssueComment') {
    if (field.name === 'id') return parent['id'];
    if (field.name === 'body') return parent['body'];
    return null;
  }

  if (parentType === 'IssueCommentEdge') {
    if (field.name === 'node') return parent['node'];
    if (field.name === 'cursor') return '';
    return null;
  }

  if (parentType === 'CreateIssuePayload' || parentType === 'CloseIssuePayload') {
    if (field.name === 'issue') return parent['issue'] ?? null;
    return null;
  }

  if (parentType === 'CreatePullRequestPayload' || parentType === 'MergePullRequestPayload') {
    if (field.name === 'pullRequest') return parent['pullRequest'] ?? null;
    return null;
  }

  if (parentType === 'AddCommentPayload') {
    if (field.name === 'commentEdge') return parent['commentEdge'] ?? null;
    return null;
  }

  if (parentType === '__Type') {
    const typeName = String(parent['__typeName'] ?? '');
    if (field.name === 'name') return typeName;
    if (field.name === 'kind') return TYPE_KIND[typeName] ?? 'OBJECT';
    if (field.name === 'description') return null;
    if (field.name === 'fields') {
      const fields = TYPE_FIELDS[typeName] ?? [];
      return fields.map((name) => ({ __type: '__Field', name }));
    }
    if (field.name === 'enumValues') {
      const values = ENUM_VALUES[typeName] ?? [];
      return values.map((name) => ({ __type: '__EnumValue', name }));
    }
    if (field.name === 'inputFields') return [];
    if (field.name === 'interfaces') return [];
    if (field.name === 'possibleTypes') return [];
    return null;
  }

  if (parentType === '__Field') {
    if (field.name === 'name') return parent['name'];
    if (field.name === 'description') return null;
    if (field.name === 'args') return [];
    return null;
  }

  if (parentType === '__EnumValue') {
    if (field.name === 'name') return parent['name'];
    if (field.name === 'description') return null;
    if (field.name === 'isDeprecated') return false;
    if (field.name === 'deprecationReason') return null;
    return null;
  }

  if (parentType === '__Schema') {
    if (field.name === 'queryType') return { __type: '__Type', __typeName: 'Query' };
    if (field.name === 'mutationType') return { __type: '__Type', __typeName: 'Mutation' };
    if (field.name === 'subscriptionType') return null;
    if (field.name === 'types') return [];
    if (field.name === 'directives') return [];
    return null;
  }

  return null;
}

// ---------------------------------------------------------------- object builders

function repositoryObject(repo: Repo): GqlObject {
  return {
    __type: 'Repository',
    __repo: repo,
    id: globalId('Repository', `${repo.owner}/${repo.name}`),
  };
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return {
    __type: 'Issue',
    __issue: issue,
    __owner: repo.owner,
    __repoName: repo.name,
    id: globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
  };
}

function pullRequestObject(repo: Repo, pull: Pull): GqlObject {
  return {
    __type: 'PullRequest',
    __pull: pull,
    __repo: repo,
    __owner: repo.owner,
    __repoName: repo.name,
    id: globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`),
  };
}

function typeObject(typeName: string): GqlObject {
  return { __type: '__Type', __typeName: typeName };
}

function issueNodes(
  repo: Repo,
  first: number,
  after: string | undefined,
  states: string[] | undefined,
  orderBy: unknown,
): GqlObject[] {
  let issues = [...repo.issues];
  if (states && states.length > 0) {
    const wanted = new Set(states.map((state) => state.toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  // Default order is newest first (number descending); CREATED_AT ASC flips it.
  let descending = true;
  if (orderBy && typeof orderBy === 'object') {
    const order = orderBy as Record<string, unknown>;
    if (String(order['direction'] ?? '') === 'ASC') descending = false;
  }
  issues.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  if (after) {
    const decoded = b64urlDecode(after);
    const cursorNumber = parseInt(decoded.replace(/^cursor:/, ''), 10);
    if (Number.isSafeInteger(cursorNumber)) {
      issues = issues.filter((issue) => (descending ? issue.number < cursorNumber : issue.number > cursorNumber));
    }
  }
  return issues.slice(0, first).map((issue) => issueObject(repo, issue));
}

function issuePageInfo(
  repo: Repo,
  first: number,
  after: string | undefined,
  states: string[] | undefined,
): GqlObject {
  const nodes = issueNodes(repo, first + 1, after, states, undefined);
  const hasNextPage = nodes.length > first;
  const page = nodes.slice(0, first);
  const last = page[page.length - 1];
  const endCursor = last ? b64urlEncode(`cursor:${(last['__issue'] as Issue).number}`) : null;
  return {
    __type: 'PageInfo',
    hasNextPage,
    hasPreviousPage: after !== undefined,
    startCursor: page.length > 0 ? b64urlEncode(`cursor:${(page[0]['__issue'] as Issue).number}`) : null,
    endCursor,
  };
}

// ---------------------------------------------------------------- global-id decoding

function decodeGlobalId(id: string): { type: string; key: string } | undefined {
  try {
    const decoded = b64urlDecode(id);
    const colon = decoded.indexOf(':');
    if (colon < 0) return undefined;
    return { type: decoded.slice(0, colon), key: decoded.slice(colon + 1) };
  } catch {
    return undefined;
  }
}

function decodeRepositoryId(forge: Forge, id: string): Repo | undefined {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.type !== 'Repository') return undefined;
  const slash = decoded.key.indexOf('/');
  if (slash < 0) return undefined;
  return forge.getRepo(decoded.key.slice(0, slash), decoded.key.slice(slash + 1));
}

function decodeIssueId(forge: Forge, id: string): { repo: Repo; issue: Issue } | undefined {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.type !== 'Issue') return undefined;
  const hash = decoded.key.indexOf('#');
  if (hash < 0) return undefined;
  const ownerRepo = decoded.key.slice(0, hash);
  const number = parseInt(decoded.key.slice(hash + 1), 10);
  const slash = ownerRepo.indexOf('/');
  if (slash < 0 || !Number.isSafeInteger(number)) return undefined;
  const repo = forge.getRepo(ownerRepo.slice(0, slash), ownerRepo.slice(slash + 1));
  if (!repo) return undefined;
  const issue = forge.getIssue(repo, number);
  if (!issue) return undefined;
  return { repo, issue };
}

function decodePullRequestId(forge: Forge, id: string): { repo: Repo; pull: Pull } | undefined {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.type !== 'PullRequest') return undefined;
  const hash = decoded.key.indexOf('#');
  if (hash < 0) return undefined;
  const ownerRepo = decoded.key.slice(0, hash);
  const number = parseInt(decoded.key.slice(hash + 1), 10);
  const slash = ownerRepo.indexOf('/');
  if (slash < 0 || !Number.isSafeInteger(number)) return undefined;
  const repo = forge.getRepo(ownerRepo.slice(0, slash), ownerRepo.slice(slash + 1));
  if (!repo) return undefined;
  const pull = forge.getPull(repo, number);
  if (!pull) return undefined;
  return { repo, pull };
}

function decodeNode(forge: Forge, id: string): GqlObject | null {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  if (decoded.type === 'Repository') {
    const repo = decodeRepositoryId(forge, id);
    if (!repo) return null;
    return repositoryObject(repo);
  }
  if (decoded.type === 'Issue') {
    const found = decodeIssueId(forge, id);
    if (!found) return null;
    return issueObject(found.repo, found.issue);
  }
  if (decoded.type === 'PullRequest') {
    const found = decodePullRequestId(forge, id);
    if (!found) return null;
    return pullRequestObject(found.repo, found.pull);
  }
  return null;
}

// ---------------------------------------------------------------- entry point

function executeOperation(forge: Forge, operation: GqlOperation, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: ExecutorContext = { forge, variables, errors: [] };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(ctx, rootType, null, operation.selections);
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out['errors'] = ctx.errors;
  return out;
}

export function handleGraphql(forge: Forge, ctx: HttpContext): HttpResponse {
  let body: unknown;
  try {
    body = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return jsonResponse(400, { message: 'request body is not valid JSON' });
  }
  const operations: Array<{ query: string; variables?: Record<string, unknown>; operationName?: string }> = Array.isArray(body)
    ? (body as Array<Record<string, unknown>>).map((item) => ({
        query: String(item['query'] ?? ''),
        variables: (item['variables'] as Record<string, unknown> | undefined) ?? {},
        operationName: item['operationName'] as string | undefined,
      }))
    : [
        {
          query: String((body as Record<string, unknown>)['query'] ?? ''),
          variables: ((body as Record<string, unknown>)['variables'] as Record<string, unknown> | undefined) ?? {},
          operationName: (body as Record<string, unknown>)['operationName'] as string | undefined,
        },
      ];
  const responses: Array<Record<string, unknown>> = [];
  for (const operation of operations) {
    if (!operation.query) {
      responses.push({ data: null, errors: [{ message: 'query is required' }] });
      continue;
    }
    try {
      const parsed = new Parser(tokenize(operation.query)).parseDocument();
      responses.push(executeOperation(forge, parsed, operation.variables ?? {}));
    } catch (err) {
      if (err instanceof ForgeError) {
        responses.push({ data: null, errors: [{ message: err.message }] });
      } else {
        responses.push({ data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] });
      }
    }
  }
  return jsonResponse(200, Array.isArray(body) ? responses : responses[0]);
}
