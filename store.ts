// The forge's whole state, in memory: repos, git objects, issues, pulls,
// labels and comments. One process, no disk, no network. Every lookup is a
// Map get, so the read/write benchmark workloads stay near a millisecond.
//
// Determinism: counters only ever increase in request order, timestamps come
// from MAKEFUN_TRIAL_NOW (or a fixed constant), and ids are assigned in
// creation order, so a replay of the same request stream rebuilds the same
// store.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { VIEWER, DEFAULT_BRANCH, DEFAULT_COMMIT_TS, DEFAULT_IDENT_NAME, DEFAULT_IDENT_EMAIL } from './scenario.ts';
import { hashObject, b64urlEncode, trialNowIso, splitPath, ZERO_OID } from './util.ts';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommitMeta {
  tree: string;
  parents: string[];
  message: string;
}

/** One cached fetch result: the pack bytes plus the shallow lists computed
 * alongside them, and the key of the shallow-relevant request inputs they
 * were computed from (see git.ts buildFetchPack). */
export interface PackCacheEntry {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
  shallowKey: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdOrder: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  commitMeta: Map<string, CommitMeta>;
  issues: Issue[];
  pulls: Pull[];
  issueByNumber: Map<number, Issue>;
  pullByNumber: Map<number, Pull>;
  labels: Map<string, Label>;
  nextIssue: number;
  nextPull: number;
  packCache: Map<string, PackCacheEntry>;
}

export class ForgeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Opaque GraphQL global id: base64url of `Type:key`, never the bare database id. */
export function globalId(type: string, key: string): string {
  return b64urlEncode(`${type}:${key}`);
}

export class Forge {
  repos: Map<string, Repo> = new Map();
  nextRepoId = 1;
  nextIssueId = 1;
  nextCommentId = 1;
  nextLabelId = 1;
  nextRepoOrder = 1;

  // ---------------------------------------------------------- repos

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    if (this.repos.has(name)) throw new ForgeError(422, 'Repository already exists');
    const repo: Repo = {
      id: this.nextRepoId,
      owner: VIEWER.login,
      name,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdOrder: this.nextRepoOrder,
      refs: new Map(),
      objects: new Map(),
      commitMeta: new Map(),
      issues: [],
      pulls: [],
      issueByNumber: new Map(),
      pullByNumber: new Map(),
      labels: new Map(),
      nextIssue: 1,
      nextPull: 1,
      packCache: new Map(),
    };
    this.nextRepoId += 1;
    this.nextRepoOrder += 1;
    this.repos.set(name, repo);
    return repo;
  }

  /** A repo is visible only under the viewer's login; any other owner is a 404. */
  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.repos.get(name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdOrder - b.createdOrder);
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    return this.repos.delete(name);
  }

  clearPackCache(repo: Repo): void {
    repo.packCache.clear();
  }

  // ---------------------------------------------------------- git objects

  /** Store an object in `repo`, returning its id (idempotent on re-store). */
  storeObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Parse and cache a commit's parents/tree/message. */
  getCommitMeta(repo: Repo, oid: string): CommitMeta | undefined {
    const cached = repo.commitMeta.get(oid);
    if (cached) return cached;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') return undefined;
    const text = obj.data.toString('utf8');
    const headerEnd = text.indexOf('\n\n');
    const header = headerEnd >= 0 ? text.slice(0, headerEnd) : text;
    const message = headerEnd >= 0 ? text.slice(headerEnd + 2) : '';
    const parents: string[] = [];
    let tree = '';
    for (const line of header.split('\n')) {
      if (line.startsWith('tree ')) tree = line.slice(5).trim();
      else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    }
    const meta: CommitMeta = { tree, parents, message };
    repo.commitMeta.set(oid, meta);
    return meta;
  }

  /** Build a commit object, store it, and return its id. */
  makeCommit(
    repo: Repo,
    treeOid: string,
    parents: string[],
    message: string,
    authorName: string,
    authorEmail: string,
    ts: number,
  ): string {
    const lines: string[] = [`tree ${treeOid}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    const ident = `${authorName} <${authorEmail}> ${ts} +0000`;
    lines.push(`author ${ident}`);
    lines.push(`committer ${ident}`);
    lines.push('');
    lines.push(message);
    const body = Buffer.from(lines.join('\n'), 'utf8');
    return this.storeObject(repo, 'commit', body);
  }

  /** Parse a tag object: its target object id. */
  tagTarget(repo: Repo, tagOid: string): string | undefined {
    const obj = repo.objects.get(tagOid);
    if (!obj || obj.type !== 'tag') return undefined;
    const firstLine = obj.data.toString('utf8').split('\n')[0] ?? '';
    if (firstLine.startsWith('object ')) return firstLine.slice(7).trim();
    return undefined;
  }

  // ---------------------------------------------------------- trees

  /**
   * Parse a tree object into its entries: mode, name, oid.
   *
   * Tree object bytes are immutable (an object id names its content forever),
   * so a parse is cached on the data Buffer itself in a WeakMap: repeat walks
   * over the same history — every fetch, every contents read — reuse the one
   * parse instead of re-slicing the same bytes. Callers only read the entries.
   */
  private treeParseCache = new WeakMap<Buffer, Array<{ mode: string; name: string; oid: string }>>();

  parseTree(data: Buffer): Array<{ mode: string; name: string; oid: string }> {
    const cached = this.treeParseCache.get(data);
    if (cached) return cached;
    const entries: Array<{ mode: string; name: string; oid: string }> = [];
    let offset = 0;
    while (offset < data.length) {
      const space = data.indexOf(0x20, offset);
      if (space < 0) break;
      const nul = data.indexOf(0, space + 1);
      if (nul < 0 || nul + 21 > data.length) break;
      const mode = data.subarray(offset, space).toString('ascii');
      const name = data.subarray(space + 1, nul).toString('utf8');
      const oid = data.subarray(nul + 1, nul + 21).toString('hex');
      entries.push({ mode, name, oid });
      offset = nul + 21;
    }
    this.treeParseCache.set(data, entries);
    return entries;
  }

  /** Flatten a tree (recursively) into path -> blob oid. */
  treeToMap(repo: Repo, treeOid: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (oid: string, prefix: string): void => {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'tree') return;
      for (const entry of this.parseTree(obj.data)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, entry.oid);
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) a tree from a flat path -> blob oid map. */
  mapToTree(repo: Repo, files: Map<string, string>): string {
    const build = (paths: string[], prefix: string): string => {
      // Group the paths at this level: files directly here, and subdirectories.
      // `paths` are relative to this directory; `prefix` is the full path of
      // this directory, so a direct file's key in `files` is prefix + '/' + name.
      const direct: Array<{ name: string; oid: string }> = [];
      const dirs = new Map<string, string[]>();
      for (const path of paths) {
        const slash = path.indexOf('/');
        if (slash < 0) {
          direct.push({ name: path, oid: files.get(prefix ? `${prefix}/${path}` : path) ?? '' });
        } else {
          const head = path.slice(0, slash);
          const rest = path.slice(slash + 1);
          const list = dirs.get(head) ?? [];
          list.push(rest);
          dirs.set(head, list);
        }
      }
      const entries: Array<{ mode: string; name: string; oid: string }> = [];
      for (const file of direct) entries.push({ mode: '100644', name: file.name, oid: file.oid });
      for (const [name, subPaths] of dirs) {
        const subTree = build(subPaths, prefix ? `${prefix}/${name}` : name);
        entries.push({ mode: '40000', name, oid: subTree });
      }
      // Git sorts entries as if directory names ended with '/'.
      entries.sort((a, b) => {
        const an = a.mode === '40000' ? `${a.name}/` : a.name;
        const bn = b.mode === '40000' ? `${b.name}/` : b.name;
        return an < bn ? -1 : an > bn ? 1 : 0;
      });
      const chunks: Buffer[] = [];
      for (const entry of entries) {
        chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
        chunks.push(Buffer.from(entry.oid, 'hex'));
      }
      return this.storeObject(repo, 'tree', Buffer.concat(chunks));
    };
    return build([...files.keys()], '');
  }

  // ---------------------------------------------------------- refs

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  listBranches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : 1));
    return out;
  }

  /** List every ref the git advertisement must show, in git order. */
  listRefs(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
    const refs: Array<{ oid: string; name: string; peeled?: string }> = [];
    const names = [...repo.refs.keys()].sort();
    for (const name of names) {
      const oid = repo.refs.get(name) ?? '';
      const entry: { oid: string; name: string; peeled?: string } = { oid, name };
      if (name.startsWith('refs/tags/')) {
        const target = this.tagTarget(repo, oid);
        if (target) entry.peeled = target;
      }
      refs.push(entry);
    }
    return refs;
  }

  /** True when `ancestor` is reachable from `descendant` through parent links. */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue: string[] = [descendant];
    while (queue.length > 0) {
      const current = queue.pop() ?? '';
      if (seen.has(current)) continue;
      seen.add(current);
      const meta = this.getCommitMeta(repo, current);
      if (!meta) continue;
      for (const parent of meta.parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** Commits reachable from `ref` (a branch name or an oid), newest first. */
  listCommits(repo: Repo, ref: string): Array<{ sha: string; message: string }> {
    let tip = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref);
    if (!tip && /^[0-9a-f]{40}$/.test(ref)) tip = ref;
    if (!tip) return [];
    // Breadth-first from the tip: depth 0 is the tip, depth 1 its parents, and
    // so on, which is exactly newest-first for a linear history.
    const depth = new Map<string, number>();
    const queue: string[] = [tip];
    depth.set(tip, 0);
    const order: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift() ?? '';
      order.push(current);
      const meta = this.getCommitMeta(repo, current);
      if (!meta) continue;
      for (const parent of meta.parents) {
        if (!depth.has(parent)) {
          depth.set(parent, (depth.get(current) ?? 0) + 1);
          queue.push(parent);
        }
      }
    }
    return order.map((sha) => ({ sha, message: this.getCommitMeta(repo, sha)?.message ?? '' }));
  }

  /** The nearest common ancestor of two commits (smallest summed depth). */
  mergeBase(repo: Repo, a: string, b: string): string | undefined {
    const depthsFrom = (tip: string): Map<string, number> => {
      const depth = new Map<string, number>();
      const queue: string[] = [tip];
      depth.set(tip, 0);
      while (queue.length > 0) {
        const current = queue.shift() ?? '';
        const meta = this.getCommitMeta(repo, current);
        if (!meta) continue;
        for (const parent of meta.parents) {
          if (!depth.has(parent)) {
            depth.set(parent, (depth.get(current) ?? 0) + 1);
            queue.push(parent);
          }
        }
      }
      return depth;
    };
    const depthA = depthsFrom(a);
    const depthB = depthsFrom(b);
    let best: string | undefined;
    let bestSum = Number.POSITIVE_INFINITY;
    for (const [oid, da] of depthA) {
      const db = depthB.get(oid);
      if (db === undefined) continue;
      if (da + db < bestSum) {
        bestSum = da + db;
        best = oid;
      }
    }
    return best;
  }

  // ---------------------------------------------------------- packs

  /** Build a pack (version 2, no deltas) from a map of oid -> object. */
  buildPack(objects: Map<string, GitObject>): Buffer {
    const oids = [...objects.keys()].sort();
    const chunks: Buffer[] = [];
    const header = Buffer.alloc(12);
    header.write('PACK', 0, 'ascii');
    header.writeUInt32BE(2, 4);
    header.writeUInt32BE(oids.length, 8);
    chunks.push(header);
    for (const oid of oids) {
      const obj = objects.get(oid) ?? { type: 'blob' as GitObjectType, data: Buffer.alloc(0) };
      const typeCode = TYPE_CODE[obj.type];
      const data = obj.data;
      const deflated = deflateSync(data);
      // Entry header: varint of (type << 4 | size low bits), then 7-bit groups.
      let size = data.length;
      const head: number[] = [];
      let first = ((typeCode << 4) | (size & 0x0f)) & 0xff;
      size >>= 4;
      if (size > 0) first |= 0x80;
      head.push(first);
      while (size > 0) {
        let next = size & 0x7f;
        size >>= 7;
        if (size > 0) next |= 0x80;
        head.push(next);
      }
      chunks.push(Buffer.from(head));
      chunks.push(deflated);
    }
    const body = Buffer.concat(chunks);
    const trailer = createHash('sha1').update(body).digest();
    return Buffer.concat([body, trailer]);
  }

  /** Read a pack, resolving OFS/REF deltas; returns oid -> object. */
  parsePack(pack: Buffer): { objects: Map<string, GitObject>; deltaCount: number } {
    if (pack.length < 32) throw new ForgeError(400, 'pack is too short');
    if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new ForgeError(400, 'pack does not start with PACK');
    const version = pack.readUInt32BE(4);
    if (version !== 2 && version !== 3) throw new ForgeError(400, `unsupported pack version ${version}`);
    const declaredCount = pack.readUInt32BE(8);
    const trailerStart = pack.length - 20;
    const trailer = pack.subarray(trailerStart).toString('hex');
    const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
    if (trailer !== computed) throw new ForgeError(400, 'pack trailer checksum mismatch');

    interface RawEntry {
      offset: number;
      typeCode: number;
      size: number;
      data: Buffer;
      baseOffset?: number;
      baseOid?: string;
    }
    const raw: RawEntry[] = [];
    const byOffset = new Map<number, RawEntry>();
    let offset = 12;
    let deltaCount = 0;
    for (let index = 0; index < declaredCount; index += 1) {
      const entryOffset = offset;
      // Varint header: first byte holds type (bits 4-6) and low 4 size bits.
      let byte = pack[offset++];
      const typeCode = (byte >> 4) & 0x07;
      let size = byte & 0x0f;
      let shift = 4;
      while (byte & 0x80) {
        byte = pack[offset++];
        size |= (byte & 0x7f) << shift;
        shift += 7;
      }
      const entry: RawEntry = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
      if (typeCode === 6) {
        deltaCount += 1;
        // OFS delta base offset.
        byte = pack[offset++];
        let value = byte & 0x7f;
        while (byte & 0x80) {
          byte = pack[offset++];
          value = ((value + 1) * 128) + (byte & 0x7f);
        }
        entry.baseOffset = entryOffset - value;
      } else if (typeCode === 7) {
        deltaCount += 1;
        if (offset + 20 > trailerStart) throw new ForgeError(400, 'ref-delta base id is truncated');
        entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
        offset += 20;
      } else if (!CODE_TYPE[typeCode]) {
        throw new ForgeError(400, `pack entry ${index} has unknown type code ${typeCode}`);
      }
      // Inflate exactly one zlib stream starting at `offset`.
      let inflated: { buffer: Buffer; engine: { bytesWritten: number } };
      try {
        inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as {
          buffer: Buffer;
          engine: { bytesWritten: number };
        };
      } catch (err) {
        throw new ForgeError(400, `zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
      }
      const written = inflated.engine.bytesWritten;
      if (!written || written <= 0) throw new ForgeError(400, `zlib stream at offset ${offset} consumed no bytes`);
      if (inflated.buffer.length !== size) {
        throw new ForgeError(400, `pack entry at ${entryOffset} declares ${size} bytes but inflated to ${inflated.buffer.length}`);
      }
      entry.data = inflated.buffer;
      offset += written;
      raw.push(entry);
      byOffset.set(entryOffset, entry);
    }
    if (offset !== trailerStart) throw new ForgeError(400, 'pack has stray bytes before its trailer');

    const objects = new Map<string, GitObject>();
    const resolved = new Map<number, { type: GitObjectType; data: Buffer; oid: string }>();
    const resolving = new Set<number>();
    const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
      const done = resolved.get(entry.offset);
      if (done) return done;
      if (resolving.has(entry.offset)) throw new ForgeError(400, 'delta cycle in pack');
      resolving.add(entry.offset);
      let type: GitObjectType;
      let data: Buffer;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset ?? -1);
        if (!baseEntry) throw new ForgeError(400, 'ofs-delta base is not in the pack');
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else if (entry.typeCode === 7) {
        const baseOid = entry.baseOid ?? '';
        const inPack = [...resolved.values()].find((r) => r.oid === baseOid);
        if (inPack) {
          type = inPack.type;
          data = applyDelta(inPack.data, entry.data);
        } else {
          // Thin pack: the base lives on this server already.
          const baseObj = [...this.repos.values()].map((r) => r.objects.get(baseOid)).find(Boolean);
          if (!baseObj) throw new ForgeError(400, 'ref-delta base is not available');
          type = baseObj.type;
          data = applyDelta(baseObj.data, entry.data);
        }
      } else {
        type = CODE_TYPE[entry.typeCode];
        data = entry.data;
      }
      const oid = hashObject(type, data);
      const result = { type, data, oid };
      resolved.set(entry.offset, result);
      objects.set(oid, { type, data });
      return result;
    };
    for (const entry of raw) resolve(entry);
    return { objects, deltaCount };
  }

  /**
   * The objects a fetch must deliver: everything reachable from `wants`,
   * minus everything reachable from `haves`. With `depth`, only `depth`
   * generations of commits from the wants, and the boundary commits are
   * reported as shallow (old boundaries that are now included are unshallow).
   */
  reachableObjects(
    repo: Repo,
    wants: string[],
    haves: string[],
    depth: number | undefined,
    oldShallow: string[],
  ): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
    // Everything the client already has: full closure from the haves. A have
    // that is also a shallow boundary is a commit the client holds WITHOUT its
    // parents (it is shallow there), so the closure stops at it: its parents
    // are not already held and must be deliverable by a deepen.
    const haveObjects = new Set<string>();
    const oldShallowSet = new Set(oldShallow);
    const collectClosure = (tips: string[]): void => {
      const queue: string[] = [...tips];
      const seenCommits = new Set<string>();
      while (queue.length > 0) {
        const oid = queue.pop() ?? '';
        if (seenCommits.has(oid)) continue;
        seenCommits.add(oid);
        const meta = this.getCommitMeta(repo, oid);
        if (!meta) continue;
        haveObjects.add(oid);
        const treeMap = this.treeToMap(repo, meta.tree);
        haveObjects.add(meta.tree);
        for (const blobOid of treeMap.values()) haveObjects.add(blobOid);
        // Add every tree object on the way down (not just the blobs).
        const collectTrees = (treeOid: string): void => {
          const obj = repo.objects.get(treeOid);
          if (!obj || obj.type !== 'tree') return;
          haveObjects.add(treeOid);
          for (const entry of this.parseTree(obj.data)) {
            if (entry.mode === '40000') collectTrees(entry.oid);
          }
        };
        collectTrees(meta.tree);
        if (oldShallowSet.has(oid)) continue;
        for (const parent of meta.parents) queue.push(parent);
      }
    };
    collectClosure(haves);

    // A want that is a tag object is delivered itself, and its target commit
    // is wanted in its place (a clone wants every ref tip, tags included).
    const expandedWants: string[] = [];
    const tagObjects: string[] = [];
    for (const want of wants) {
      const obj = repo.objects.get(want);
      if (obj && obj.type === 'tag') {
        tagObjects.push(want);
        const target = this.tagTarget(repo, want);
        if (target) expandedWants.push(target);
      } else {
        expandedWants.push(want);
      }
    }

    const wanted = new Map<string, GitObject>();
    const addObject = (oid: string): void => {
      if (haveObjects.has(oid)) return;
      const obj = repo.objects.get(oid);
      if (obj) wanted.set(oid, obj);
    };
    const addTree = (treeOid: string): void => {
      addObject(treeOid);
      const obj = repo.objects.get(treeOid);
      if (!obj || obj.type !== 'tree') return;
      for (const entry of this.parseTree(obj.data)) {
        if (entry.mode === '40000') addTree(entry.oid);
        else addObject(entry.oid);
      }
    };

    const shallow: string[] = [];
    const unshallow: string[] = [];
    if (depth === undefined) {
      const queue: string[] = [...expandedWants];
      const seen = new Set<string>();
      while (queue.length > 0) {
        const oid = queue.pop() ?? '';
        if (seen.has(oid)) continue;
        seen.add(oid);
        const meta = this.getCommitMeta(repo, oid);
        if (!meta) continue;
        addObject(oid);
        addTree(meta.tree);
        for (const parent of meta.parents) queue.push(parent);
      }
    } else {
      // Generations from the wants: level 0 is the wants, level k+1 their parents.
      let level: string[] = [...new Set(expandedWants)];
      const included = new Set<string>();
      for (let generation = 0; generation < depth; generation += 1) {
        const next: string[] = [];
        for (const oid of level) {
          if (included.has(oid)) continue;
          included.add(oid);
          const meta = this.getCommitMeta(repo, oid);
          if (!meta) continue;
          addObject(oid);
          addTree(meta.tree);
          for (const parent of meta.parents) next.push(parent);
        }
        if (generation === depth - 1) {
          // The last included generation is the new shallow boundary.
          for (const oid of level) shallow.push(oid);
        }
        level = next;
      }
      for (const boundary of oldShallow) {
        if (included.has(boundary)) unshallow.push(boundary);
      }
    }
    for (const tagOid of tagObjects) addObject(tagOid);
    return { objects: wanted, shallow, unshallow };
  }

  // ---------------------------------------------------------- contents

  /**
   * Write or replace a file on a branch, creating the branch from the default
   * tip when it does not exist yet. Returns the new commit and blob ids.
   */
  putContents(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
    sha: string | undefined,
  ): { commitSha: string; blobSha: string; created: boolean } {
    const tip = this.branchTip(repo, branch) ?? this.branchTip(repo, repo.defaultBranch);
    const files = tip ? this.treeToMap(repo, this.getCommitMeta(repo, tip)?.tree ?? '') : new Map<string, string>();
    const existing = files.get(path);
    if (existing !== undefined) {
      if (sha === undefined) throw new ForgeError(422, 'sha is required to update an existing file');
      if (sha !== existing) throw new ForgeError(409, 'sha does not match the current file');
    }
    const blobSha = this.storeObject(repo, 'blob', content);
    files.set(path, blobSha);
    const treeOid = this.mapToTree(repo, files);
    const commitSha = this.makeCommit(
      repo,
      treeOid,
      tip ? [tip] : [],
      message,
      VIEWER.name,
      VIEWER.email,
      DEFAULT_COMMIT_TS,
    );
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    this.clearPackCache(repo);
    return { commitSha, blobSha, created: existing === undefined };
  }

  getContents(
    repo: Repo,
    ref: string | undefined,
    path: string,
  ): { kind: 'file'; sha: string; size: number; content: Buffer } | { kind: 'dir'; entries: Array<{ type: string; name: string; path: string; sha: string; size: number }> } {
    const branch = ref ?? repo.defaultBranch;
    const tip = this.branchTip(repo, branch) ?? repo.refs.get(ref ?? '');
    if (!tip) throw new ForgeError(404, 'Not Found');
    const meta = this.getCommitMeta(repo, tip);
    if (!meta) throw new ForgeError(404, 'Not Found');
    const files = this.treeToMap(repo, meta.tree);
    const clean = splitPath(path).join('/');
    if (clean === '') {
      return { kind: 'dir', entries: this.dirListing(repo, meta.tree, '') };
    }
    const blobOid = files.get(clean);
    if (blobOid) {
      const obj = repo.objects.get(blobOid);
      if (!obj) throw new ForgeError(404, 'Not Found');
      return { kind: 'file', sha: blobOid, size: obj.data.length, content: obj.data };
    }
    // A directory prefix: resolve its subtree and list its direct children.
    const subTree = this.treeAtPath(repo, meta.tree, clean);
    if (!subTree) throw new ForgeError(404, 'Not Found');
    return { kind: 'dir', entries: this.dirListing(repo, subTree, clean) };
  }

  /** Resolve the subtree object id for `dirPath` inside `treeOid`. */
  private treeAtPath(repo: Repo, treeOid: string, dirPath: string): string | undefined {
    let current = treeOid;
    for (const part of splitPath(dirPath)) {
      const obj = repo.objects.get(current);
      if (!obj || obj.type !== 'tree') return undefined;
      const entry = this.parseTree(obj.data).find((item) => item.name === part && item.mode === '40000');
      if (!entry) return undefined;
      current = entry.oid;
    }
    return current;
  }

  private dirListing(repo: Repo, treeOid: string, prefix: string): Array<{ type: string; name: string; path: string; sha: string; size: number }> {
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return [];
    const entries: Array<{ type: string; name: string; path: string; sha: string; size: number }> = [];
    for (const entry of this.parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') {
        entries.push({ type: 'dir', name: entry.name, path, sha: entry.oid, size: 0 });
      } else {
        const blob = repo.objects.get(entry.oid);
        entries.push({ type: 'file', name: entry.name, path, sha: entry.oid, size: blob?.data.length ?? 0 });
      }
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    return entries;
  }

  deleteContents(repo: Repo, branch: string, path: string, message: string, sha: string | undefined): string {
    const tip = this.branchTip(repo, branch);
    if (!tip) throw new ForgeError(404, 'Not Found');
    const meta = this.getCommitMeta(repo, tip);
    if (!meta) throw new ForgeError(404, 'Not Found');
    const files = this.treeToMap(repo, meta.tree);
    const clean = splitPath(path).join('/');
    const existing = files.get(clean);
    if (existing === undefined) throw new ForgeError(404, 'Not Found');
    if (sha !== undefined && sha !== existing) throw new ForgeError(409, 'sha does not match the current file');
    files.delete(clean);
    const treeOid = this.mapToTree(repo, files);
    const commitSha = this.makeCommit(repo, treeOid, [tip], message, VIEWER.name, VIEWER.email, DEFAULT_COMMIT_TS);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    this.clearPackCache(repo);
    return commitSha;
  }

  // ---------------------------------------------------------- labels

  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label: Label = { id: this.nextLabelId, name, color };
    this.nextLabelId += 1;
    repo.labels.set(name, label);
    return label;
  }

  // ---------------------------------------------------------- issues

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (!label) throw new ForgeError(422, `label does not exist: ${name}`);
      labels.push(label);
    }
    const now = trialNowIso();
    const issue: Issue = {
      id: this.nextIssueId,
      number: repo.nextIssue,
      title,
      body,
      state: 'open',
      labels,
      comments: [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    this.nextIssueId += 1;
    repo.nextIssue += 1;
    repo.issues.push(issue);
    repo.issueByNumber.set(issue.number, issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issueByNumber.get(number);
  }

  listIssues(repo: Repo, state: string, direction: string): Issue[] {
    const filtered = state === 'all' ? [...repo.issues] : repo.issues.filter((issue) => issue.state === state);
    filtered.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    return filtered;
  }

  addComment(repo: Repo, issueNumber: number, body: string): IssueComment {
    const issue = this.getIssue(repo, issueNumber);
    if (!issue) throw new ForgeError(404, 'Not Found');
    const now = trialNowIso();
    const comment: IssueComment = { id: this.nextCommentId, body, createdAt: now, updatedAt: now };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  // ---------------------------------------------------------- pulls

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull {
    const headSha = this.branchTip(repo, headRef);
    const baseSha = this.branchTip(repo, baseRef);
    if (!headSha) throw new ForgeError(422, `head branch does not exist: ${headRef}`);
    if (!baseSha) throw new ForgeError(422, `base branch does not exist: ${baseRef}`);
    const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef);
    if (duplicate) throw new ForgeError(422, 'a pull request from this branch is already open');
    const now = trialNowIso();
    const pull: Pull = {
      id: this.nextIssueId,
      number: repo.nextPull,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: now,
      updatedAt: now,
    };
    this.nextIssueId += 1;
    repo.nextPull += 1;
    repo.pulls.push(pull);
    repo.pullByNumber.set(pull.number, pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pullByNumber.get(number);
  }

  listPulls(repo: Repo, state: string): Pull[] {
    if (state === 'all') return [...repo.pulls];
    return repo.pulls.filter((pull) => pull.state === state);
  }

  /** File diff between the pull's base tip (at creation) and its head tip now. */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const headMeta = this.getCommitMeta(repo, headTip);
    const baseMeta = this.getCommitMeta(repo, pull.baseSha);
    const headFiles = headMeta ? this.treeToMap(repo, headMeta.tree) : new Map<string, string>();
    const baseFiles = baseMeta ? this.treeToMap(repo, baseMeta.tree) : new Map<string, string>();
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set([...headFiles.keys(), ...baseFiles.keys()]);
    for (const path of [...paths].sort()) {
      const headOid = headFiles.get(path);
      const baseOid = baseFiles.get(path);
      if (headOid === baseOid) continue;
      let status = 'modified';
      let additions = 0;
      let deletions = 0;
      if (headOid === undefined) {
        status = 'removed';
        deletions = this.countLines(repo, baseOid);
      } else if (baseOid === undefined) {
        status = 'added';
        additions = this.countLines(repo, headOid);
      } else {
        const headLines = this.linesOf(repo, headOid);
        const baseLines = this.linesOf(repo, baseOid);
        const baseSet = new Set(baseLines);
        const headSet = new Set(headLines);
        additions = headLines.filter((line) => !baseSet.has(line)).length;
        deletions = baseLines.filter((line) => !headSet.has(line)).length;
        if (additions === 0 && deletions === 0) additions = 1;
      }
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }

  private countLines(repo: Repo, oid: string | undefined): number {
    if (!oid) return 0;
    const obj = repo.objects.get(oid);
    if (!obj) return 0;
    return this.linesOf(repo, oid).length;
  }

  private linesOf(repo: Repo, oid: string): string[] {
    const obj = repo.objects.get(oid);
    if (!obj) return [];
    const text = obj.data.toString('utf8');
    if (text === '') return [];
    return text.split('\n');
  }

  /** True when the pull would conflict in a 3-way merge against the base tip. */
  pullConflicts(repo: Repo, pull: Pull): boolean {
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const baseTip = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const base = this.mergeBase(repo, headTip, baseTip);
    if (!base) return false;
    const baseMeta = this.getCommitMeta(repo, base);
    const headMeta = this.getCommitMeta(repo, headTip);
    const tipMeta = this.getCommitMeta(repo, baseTip);
    if (!baseMeta || !headMeta || !tipMeta) return false;
    const baseFiles = this.treeToMap(repo, baseMeta.tree);
    const headFiles = this.treeToMap(repo, headMeta.tree);
    const tipFiles = this.treeToMap(repo, tipMeta.tree);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
    for (const path of paths) {
      const atBase = baseFiles.get(path);
      const atHead = headFiles.get(path);
      const atTip = tipFiles.get(path);
      if (atHead !== atBase && atTip !== atBase && atHead !== atTip) return true;
    }
    return false;
  }

  /**
   * Squash-merge a pull: one commit whose tree is the head tip's tree and whose
   * parent is the base tip, landing on the base branch. Returns the merge sha.
   */
  mergePull(repo: Repo, pull: Pull): string {
    if (pull.state !== 'open') throw new ForgeError(405, 'pull request is not open');
    if (this.pullConflicts(repo, pull)) throw new ForgeError(405, 'merge conflict');
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const baseTip = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const headMeta = this.getCommitMeta(repo, headTip);
    if (!headMeta) throw new ForgeError(422, 'head commit is missing');
    const message = `${pull.title} (#${pull.number})`;
    const mergeSha = this.makeCommit(repo, headMeta.tree, [baseTip], message, VIEWER.name, VIEWER.email, DEFAULT_COMMIT_TS);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = trialNowIso();
    pull.mergeCommitSha = mergeSha;
    pull.updatedAt = trialNowIso();
    this.clearPackCache(repo);
    return mergeSha;
  }
}
