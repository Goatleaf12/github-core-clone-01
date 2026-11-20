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

export function createApp(): Server {
  const forge = new Forge();

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const ctx: HttpContext = {
          method: req.method ?? 'GET',
          pathname: url.pathname,
          query: url.searchParams,
          headers: req.headers,
          body: Buffer.alloc(0),
        };

        if (ctx.method === 'GET' && ctx.pathname === '/healthz') {
          sendResponse(res, jsonResponse(200, { ok: true }));
          return;
        }

        ctx.body = requestHasBody(req) ? await readBody(req) : EMPTY_BODY;

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
        if (err instanceof ForgeError) {
          sendResponse(res, jsonResponse(err.status, { message: err.message }));
          return;
        }
        process.stderr.write(`[entry] unhandled error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        sendResponse(res, jsonResponse(500, { message: 'Internal Server Error' }));
      }
    })();
  });

  // The trial's clients always complete their requests, and the trial's wall
  // budget is enforced outside the entry, so Node's per-request header and
  // request deadlines only cost a timer arm on every request here.
  server.headersTimeout = 0;
  server.requestTimeout = 0;

  return server;
}
