// The HTTP server: one Node http server, one Forge, four route families.
// Every request gets a deterministic X-GitHub-Request-Id from a counter
// (never a clock or a random value). Every API route except /healthz requires
// the bearer token the trial sets in MAKEFUN_SHOP_TOKEN; outside a trial any
// non-empty bearer is accepted so local runs work.
//
// Routing:
//   GET  /healthz              200 {"ok":true}, no auth (the boot probe)
//   /api/v3/...                REST v3 (rest.ts)
//   POST /api/graphql          GraphQL v4 (graphql.ts)
//   POST /mcp                  MCP JSON-RPC (mcp.ts)
//   /<owner>/<repo>.git/...    git smart HTTP (git.ts)
//   anything else              JSON 404
//
// The server never throws out of a request: a handler error becomes a JSON
// error reply with the handler's status, and anything unexpected becomes a
// 500 JSON reply while the process keeps serving.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, ForgeError } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit, jsonResponse, type HttpContext, type HttpResponse } from './git.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function bearerToken(ctx: HttpContext): string {
  const header = ctx.headers['authorization'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !value.startsWith('Bearer ')) return '';
  return value.slice('Bearer '.length);
}

function authorized(ctx: HttpContext): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const presented = bearerToken(ctx);
  if (presented === '') return false;
  if (expected === '') return true;
  return presented === expected;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) reject(new ForgeError(413, 'request body is too large'));
      else if (chunks.length === 1) resolve(chunks[0]);
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => reject(err));
  });
}

const EMPTY_BODY = Buffer.alloc(0);

/**
 * Whether the request carries a body at all. In HTTP/1.1 a body exists only
 * with a transfer-encoding or a non-zero content-length, so a request with
 * neither can skip the stream round trip: its body is empty by definition,
 * which is exactly what readBody would resolve after 'end'.
 */
function requestHasBody(req: IncomingMessage): boolean {
  if (req.headers['transfer-encoding'] !== undefined) return true;
  const length = req.headers['content-length'];
  return length !== undefined && length !== '0';
}

function sendResponse(res: ServerResponse, response: HttpResponse): void {
  const headers: Record<string, string> = { ...response.headers };
  headers['x-github-request-id'] = nextRequestId();
  if (response.status !== 204) {
    headers['content-length'] = String(response.body.length);
  }
  res.writeHead(response.status, headers);
  res.end(response.body);
}

const DOT_SEGMENT = /(^|\/)(?:\.|%2e){1,2}(?=\/|$)/i;

/**
 * Split a request target into pathname + query. When the target contains no
 * backslash, no fragment, no control characters and no dot segment (literal
 * or %2e-encoded), WHATWG URL parsing is the identity on the pathname and
 * parses the query the same way, so the split is done by hand; anything else
 * takes the full parser, exactly as before.
 */
function parseTarget(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  const target = req.url ?? '/';
  const clean =
    target.startsWith('/') &&
    !target.includes('\\') &&
    !target.includes('#') &&
    !target.includes('\t') &&
    !target.includes('\r') &&
    !target.includes('\n') &&
    !DOT_SEGMENT.test(target);
  if (!clean) {
    const url = new URL(target, 'http://127.0.0.1');
    return { pathname: url.pathname, query: url.searchParams };
  }
  const q = target.indexOf('?');
  if (q < 0) return { pathname: target, query: new URLSearchParams() };
  return { pathname: target.slice(0, q), query: new URLSearchParams(target.slice(q + 1)) };
}

/** The one error mapping every request path shares. */
function fail(res: ServerResponse, err: unknown): void {
  if (err instanceof ForgeError) {
    sendResponse(res, jsonResponse(err.status, { message: err.message }));
    return;
  }
  process.stderr.write(`[entry] unhandled error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  sendResponse(res, jsonResponse(500, { message: 'Internal Server Error' }));
}

/** Auth, routing and the reply — synchronous once the body is in hand. */
function dispatch(forge: Forge, ctx: HttpContext, res: ServerResponse): void {
  try {
    if (!authorized(ctx)) {
      sendResponse(res, jsonResponse(401, { message: 'Requires authentication' }));
      return;
    }
    let response: HttpResponse;
    if (ctx.pathname === '/api/graphql' && ctx.method === 'POST') {
      response = handleGraphql(forge, ctx);
    } else if (ctx.pathname === '/mcp' && ctx.method === 'POST') {
      response = handleMcp(forge, ctx);
    } else if (ctx.pathname.startsWith('/api/v3')) {
      response = handleRest(forge, ctx);
    } else if (/^\/[^/]+\/[^/]+\.git(\/.*)?$/.test(ctx.pathname)) {
      response = handleGit(forge, ctx);
    } else {
      response = jsonResponse(404, { message: 'Not Found' });
    }
    sendResponse(res, response);
  } catch (err) {
    fail(res, err);
  }
}

export function createApp(): Server {
  const forge = new Forge();

  const server = createServer((req, res) => {
    let target: { pathname: string; query: URLSearchParams };
    try {
      target = parseTarget(req);
    } catch (err) {
      fail(res, err);
      return;
    }
    const { pathname, query } = target;
    const ctx: HttpContext = {
      method: req.method ?? 'GET',
      pathname,
      query,
      headers: req.headers,
      body: EMPTY_BODY,
    };

    if (ctx.method === 'GET' && ctx.pathname === '/healthz') {
      sendResponse(res, jsonResponse(200, { ok: true }));
      return;
    }

    // Bodyless requests are routed and answered synchronously, in the
    // connection callback itself — no promise chain between the request
    // arriving and its reply leaving. Requests with a body chain off the
    // body promise directly.
    if (!requestHasBody(req)) {
      dispatch(forge, ctx, res);
      return;
    }
    readBody(req).then(
      (body) => {
        ctx.body = body;
        dispatch(forge, ctx, res);
      },
      (err: unknown) => fail(res, err),
    );
  });

  // The trial's clients always complete their requests, and the trial's wall
  // budget is enforced outside the entry, so Node's per-request header and
  // request deadlines only cost a timer arm on every request here.
  server.headersTimeout = 0;
  server.requestTimeout = 0;

  return server;
}
