// Small pure helpers shared by every module: hashing, compression, base64 and
// the deterministic clock. Nothing here touches the network or the filesystem,
// so these functions are safe to call from any request path.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** Hex SHA-1 of raw bytes or a string. */
export function sha1Hex(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of `<type> <length>\0<body>`. */
export function hashObject(type: string, body: Buffer): string {
  const header = Buffer.from(`${type} ${body.length}\0`, 'latin1');
  return sha1Hex(Buffer.concat([header, body]));
}

/** The full on-disk form of a git object: `<type> <length>\0<body>`. */
export function objectBytes(type: string, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${body.length}\0`, 'latin1'), body]);
}

export function zlibDeflate(data: Buffer): Buffer {
  return deflateSync(data);
}

export function zlibInflate(data: Buffer): Buffer {
  return inflateSync(data);
}

export function b64encode(buf: Buffer): string {
  return buf.toString('base64');
}

export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/\s/g, ''), 'base64');
}

/** Base64url without padding, for opaque global ids. */
export function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function b64urlDecode(text: string): string {
  return Buffer.from(text, 'base64url').toString('utf8');
}

/**
 * The one timestamp the whole store stamps on created/updated rows. The trial
 * sets MAKEFUN_TRIAL_NOW; outside a trial a fixed constant keeps every reply
 * deterministic. Never Date.now() here.
 *
 * The result is a pure function of the env value, so it is memoized on that
 * value: the env read itself is the only cost worth paying per call, and only
 * until the value is seen once.
 */
let trialNowCache: { raw: string | undefined; iso: string } | undefined;

export function trialNowIso(): string {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (trialNowCache && trialNowCache.raw === raw) return trialNowCache.iso;
  const iso = raw ?? '2025-01-01T00:00:00.000Z';
  trialNowCache = { raw, iso };
  return iso;
}

/** A JSON-safe deep clone through stringify/parse (inputs are plain data). */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Split a path like "a/b/c.txt" into its segments, dropping empty ones. */
export function splitPath(path: string): string[] {
  return path.split('/').filter((part) => part.length > 0);
}

/** True when `text` is a 40-hex git object id. */
export function isObjectId(text: string): boolean {
  return /^[0-9a-f]{40}$/.test(text);
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
