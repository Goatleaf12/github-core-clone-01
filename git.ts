// Git smart HTTP: protocol v2 upload-pack (advertisement, ls-refs, fetch),
// protocol v0 upload-pack (advertisement, fetch), and v0 receive-pack (push
// with report-status). No git binary, no disk: objects live in the Forge's
// in-memory store and packs are built on the fly (cached per head sha).
//
// Wire notes the checks pin down:
//  - v2 is answered only when the request carries `Git-Protocol: version=2`.
//  - v0 advertisements open with `# service=...` and carry capabilities on
//    the first ref line (or on a `capabilities^{}` line for an empty repo).
//  - A peeled `^{}` line must follow its base tag line, never precede it.
//  - fetch answers in sections: acknowledgments (NAK), shallow-info, packfile.
//  - A packfile section must carry at least one sideband packet, even for an
//    empty pack, or the client errors.
//  - Push reports live inside sideband band 1 as pkt-lines: `unpack ok` then
//    one `ok`/`ng` line per ref; a refused ref's reason is exactly
//    `non-fast-forward`.
//  - A malformed pkt-line request must never crash the server: answer 400.

import { ForgeError, type Forge, type Repo } from './store.ts';
import { ZERO_OID, decodeSegment } from './util.ts';

export interface HttpContext {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export function jsonResponse(status: number, value: unknown, extraHeaders: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  };
}

export function textResponse(status: number, text: string, contentType: string): HttpResponse {
  return { status, headers: { 'content-type': contentType }, body: Buffer.from(text, 'utf8') };
}

const AGENT = 'forge/1.0';

// ---------------------------------------------------------------- pkt-lines

type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

function pktLine(text: string): Buffer {
  return pktLineBytes(Buffer.from(text, 'utf8'));
}

function pktLineBytes(payload: Buffer): Buffer {
  const length = payload.length + 4;
  if (length > 65520) throw new ForgeError(400, 'pkt-line too long');
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

/** Control packets are constant bytes; they are only ever read (concatenated
 * into a response), never mutated, so one instance serves every response. */
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

function pktFlush(): Buffer {
  return PKT_FLUSH;
}

function pktDelim(): Buffer {
  return PKT_DELIM;
}

/** Decode a whole buffer of pkt-lines. Throws ForgeError(400) on bad framing. */
function decodePktLines(buffer: Buffer): { packets: Packet[]; bytesConsumed: number } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new ForgeError(400, 'pkt-line header is truncated');
    const lengthText = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lengthText)) throw new ForgeError(400, 'pkt-line length is not hex');
    const length = parseInt(lengthText, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new ForgeError(400, 'pkt-line length is out of range');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, bytesConsumed: offset };
}

/** Encode data lines; the strings 'flush'/'delim' become control packets. */
function encodePktLines(lines: Array<string | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else if (line === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** Wrap bytes in sideband band `band`, chunked to the pkt-line size limit. */
function sideband(band: number, data: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  if (data.length === 0) {
    parts.push(pktLineBytes(Buffer.concat([Buffer.from([band])])));
    return Buffer.concat(parts);
  }
  while (offset < data.length) {
    const chunk = data.subarray(offset, offset + 65515);
    parts.push(pktLineBytes(Buffer.concat([Buffer.from([band]), chunk])));
    offset += chunk.length;
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- advertisements

const UPLOAD_V0_CAPS =
  'symref=HEAD:refs/heads/main agent=forge/1.0 side-band-64k thin-pack ofs-delta multi_ack_detailed shallow';
const RECEIVE_V0_CAPS = 'report-status delete-refs side-band-64k agent=forge/1.0 ofs-delta thin-pack';

/** The v2 capability advertisement never changes, so it is encoded once. */
const ADVERTISE_V2 = encodePktLines([
  'version 2\n',
  `agent=${AGENT}\n`,
  'ls-refs=unborn\n',
  'fetch=shallow\n',
  'object-format=sha1\n',
  'flush',
]);

function advertiseV2(): Buffer {
  return ADVERTISE_V2;
}

function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const allRefs = listAdvertisedRefs(repo);
  if (allRefs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const mainTip = repo.refs.get('refs/heads/main') ?? allRefs[0].oid;
    parts.push(pktLine(`${mainTip} HEAD\0${caps}\n`));
    for (const ref of allRefs) parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
    for (const ref of allRefs) {
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function listAdvertisedRefs(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const out: Array<{ oid: string; name: string; peeled?: string }> = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) ?? '';
    const entry: { oid: string; name: string; peeled?: string } = { oid, name };
    if (name.startsWith('refs/tags/')) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        const firstLine = obj.data.toString('utf8').split('\n')[0] ?? '';
        if (firstLine.startsWith('object ')) entry.peeled = firstLine.slice(7).trim();
      }
    }
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------- upload-pack

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
  deepenSince: number | undefined;
  deepenNot: string[];
}

function parseFetchLines(lines: string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: undefined, deepenSince: undefined, deepenNot: [] };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) request.wants.push(text.slice(5).split(' ')[0]);
    else if (text.startsWith('have ')) request.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) request.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = parseInt(text.slice(7).trim(), 10);
      if (Number.isSafeInteger(n) && n > 0) request.depth = n;
    } else if (text.startsWith('deepen-since ')) {
      const n = parseInt(text.slice(13).trim(), 10);
      if (Number.isSafeInteger(n)) request.deepenSince = n;
    } else if (text.startsWith('deepen-not ')) request.deepenNot.push(text.slice(11).trim());
  }
  return request;
}

function buildFetchPack(forge: Forge, repo: Repo, request: FetchRequest): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const key = JSON.stringify({ w: [...request.wants].sort(), h: [...request.haves].sort(), d: request.depth ?? null });
  // The shallow lists depend on more than the pack key: the client's existing
  // shallow boundaries and any deepen modifiers. They are cached alongside
  // the pack, keyed by exactly those inputs, and reused only when they match;
  // any other shape takes the recompute path, as before.
  const shallowKey = JSON.stringify({
    s: [...request.shallow].sort(),
    since: request.deepenSince ?? null,
    not: [...request.deepenNot].sort(),
  });
  const cached = repo.packCache.get(key);
  if (cached) {
    if (cached.shallowKey === shallowKey) {
      return { pack: cached.pack, shallow: cached.shallow, unshallow: cached.unshallow };
    }
    // Recompute the shallow lists but reuse the pack bytes.
    const { shallow, unshallow } = forge.reachableObjects(repo, request.wants, request.haves, request.depth, request.shallow);
    return { pack: cached.pack, shallow, unshallow };
  }
  const { objects, shallow, unshallow } = forge.reachableObjects(repo, request.wants, request.haves, request.depth, request.shallow);
  const pack = forge.buildPack(objects);
  repo.packCache.set(key, { pack, shallow, unshallow, shallowKey });
  return { pack, shallow, unshallow };
}

function handleLsRefs(repo: Repo, lines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  void unborn;
  const out: Buffer[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  // HEAD is a ref like any other for prefix filtering: it only appears when no
  // prefix was asked for, or when a prefix matches the name "HEAD" itself.
  const headVisible = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (mainTip) {
    if (headVisible) {
      const suffix = symrefs ? ' symref-target:refs/heads/main' : '';
      out.push(pktLine(`${mainTip} HEAD${suffix}\n`));
    }
  } else if (headVisible) {
    out.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
  }
  for (const ref of listAdvertisedRefs(repo)) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    out.push(pktLine(`${line}\n`));
  }
  out.push(pktFlush());
  return Buffer.concat(out);
}

/** Section headers every fetch reply carries, encoded once. */
const PKT_ACKNOWLEDGMENTS = pktLine('acknowledgments\n');
const PKT_NAK = pktLine('NAK\n');
const PKT_SHALLOW_INFO = pktLine('shallow-info\n');
const PKT_PACKFILE = pktLine('packfile\n');
const SIDEBAND_ONE = Buffer.from([1]);

/**
 * A pack framed as one band-1 sideband packet, in a single copy. Falls back
 * to the chunked sideband framing when the pack exceeds one packet.
 */
function framedPack(pack: Buffer): Buffer {
  if (pack.length + 5 > 65520) return sideband(1, pack);
  const header = Buffer.from((pack.length + 5).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, SIDEBAND_ONE, pack]);
}

function handleFetchV2(forge: Forge, repo: Repo, lines: string[]): Buffer {
  const request = parseFetchLines(lines);
  const { pack, shallow, unshallow } = buildFetchPack(forge, repo, request);
  const parts: Buffer[] = [];
  parts.push(PKT_ACKNOWLEDGMENTS);
  parts.push(PKT_NAK);
  parts.push(pktFlush());
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(PKT_SHALLOW_INFO);
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  parts.push(PKT_PACKFILE);
  parts.push(framedPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function handleFetchV0(forge: Forge, repo: Repo, lines: string[]): Buffer {
  const request = parseFetchLines(lines);
  const { pack, shallow, unshallow } = buildFetchPack(forge, repo, request);
  const parts: Buffer[] = [PKT_NAK];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(framedPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function handleUploadPack(forge: Forge, repo: Repo, ctx: HttpContext): HttpResponse {
  const isV2 = (ctx.headers['git-protocol'] ?? '') === 'version=2';
  let lines: string[];
  try {
    const { packets } = decodePktLines(ctx.body);
    lines = packets.filter((p): p is { kind: 'data'; payload: Buffer } => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  } catch (err) {
    if (err instanceof ForgeError) return jsonResponse(err.status, { message: err.message });
    throw err;
  }
  const command = lines[0]?.replace(/\n$/, '') ?? '';
  if (isV2 && command === 'command=ls-refs') {
    return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: handleLsRefs(repo, lines.slice(1)) };
  }
  if (isV2 && command === 'command=fetch') {
    return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: handleFetchV2(forge, repo, lines.slice(1)) };
  }
  if (!isV2) {
    return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: handleFetchV0(forge, repo, lines) };
  }
  return jsonResponse(400, { message: `unsupported upload-pack command: ${command}` });
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(forge: Forge, repo: Repo, ctx: HttpContext): HttpResponse {
  // Commands run until the first flush packet; everything after it is the
  // pack, which is NOT pkt-lines — so the framing is walked one packet at a
  // time and stops at the flush instead of decoding the whole body.
  const commandLines: string[] = [];
  let packStart = ctx.body.length;
  let offset = 0;
  try {
    while (offset < ctx.body.length) {
      if (offset + 4 > ctx.body.length) throw new ForgeError(400, 'pkt-line header is truncated');
      const lengthText = ctx.body.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(lengthText)) throw new ForgeError(400, 'pkt-line length is not hex');
      const length = parseInt(lengthText, 16);
      if (length === 0) {
        packStart = offset + 4;
        break;
      }
      if (length === 1 || length === 2) {
        offset += 4;
        continue;
      }
      if (length < 4 || offset + length > ctx.body.length) throw new ForgeError(400, 'pkt-line length is out of range');
      commandLines.push(ctx.body.subarray(offset + 4, offset + length).toString('utf8'));
      offset += length;
    }
  } catch (err) {
    if (err instanceof ForgeError) return jsonResponse(err.status, { message: err.message });
    throw err;
  }
  const packBytes = ctx.body.subarray(packStart);
  const commands: PushCommand[] = [];
  for (let index = 0; index < commandLines.length; index += 1) {
    let line = commandLines[index].replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }

  const reportLines: string[] = [];
  let unpackOk = true;
  if (packBytes.length > 0) {
    try {
      const { objects } = forge.parsePack(packBytes);
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackOk = false;
      reportLines.push(`unpack ${(err as Error).message}\n`);
    }
  }
  if (unpackOk) {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const result = applyPushCommand(forge, repo, command);
      reportLines.push(result);
    }
    forge.clearPackCache(repo);
  }
  const report = encodePktLines(reportLines);
  const body = Buffer.concat([sideband(1, report), pktFlush()]);
  return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' }, body };
}

function applyPushCommand(forge: Forge, repo: Repo, command: PushCommand): string {
  const current = repo.refs.get(command.ref);
  const isTag = command.ref.startsWith('refs/tags/');
  if (command.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return `ng ${command.ref} remote ref does not exist\n`;
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) return `ng ${command.ref} non-fast-forward\n`;
    repo.refs.delete(command.ref);
    return `ok ${command.ref}\n`;
  }
  if (command.oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return `ng ${command.ref} non-fast-forward\n`;
    const obj = repo.objects.get(command.newOid);
    if (!obj) return `ng ${command.ref} object not found\n`;
    repo.refs.set(command.ref, command.newOid);
    return `ok ${command.ref}\n`;
  }
  // Update.
  if (current === undefined) return `ng ${command.ref} remote ref does not exist\n`;
  if (command.oldOid !== current) return `ng ${command.ref} non-fast-forward\n`;
  if (isTag) return `ng ${command.ref} non-fast-forward\n`;
  const obj = repo.objects.get(command.newOid);
  if (!obj || obj.type !== 'commit') return `ng ${command.ref} object not found\n`;
  if (!forge.isAncestor(repo, current, command.newOid)) return `ng ${command.ref} non-fast-forward\n`;
  repo.refs.set(command.ref, command.newOid);
  return `ok ${command.ref}\n`;
}

// ---------------------------------------------------------------- routing

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/;

export function handleGit(forge: Forge, ctx: HttpContext): HttpResponse {
  const match = GIT_PATH.exec(ctx.pathname);
  if (!match) return jsonResponse(404, { message: 'Not Found' });
  const owner = decodeSegment(match[1]);
  const repoName = decodeSegment(match[2]);
  const suffix = match[3] ?? '';
  const repo = forge.getRepo(owner, repoName);
  if (!repo) return jsonResponse(404, { message: 'Not Found' });

  if (ctx.method === 'GET' && suffix === '/info/refs') {
    const service = ctx.query.get('service') ?? '';
    if (service === 'git-upload-pack') {
      const isV2 = (ctx.headers['git-protocol'] ?? '') === 'version=2';
      if (isV2) {
        return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' }, body: advertiseV2() };
      }
      return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' }, body: advertiseV0(repo, 'git-upload-pack') };
    }
    if (service === 'git-receive-pack') {
      return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-advertisement' }, body: advertiseV0(repo, 'git-receive-pack') };
    }
    return jsonResponse(400, { message: `unknown service: ${service}` });
  }
  if (ctx.method === 'POST' && suffix === '/git-upload-pack') {
    return handleUploadPack(forge, repo, ctx);
  }
  if (ctx.method === 'POST' && suffix === '/git-receive-pack') {
    return handleReceivePack(forge, repo, ctx);
  }
  return jsonResponse(404, { message: 'Not Found' });
}
