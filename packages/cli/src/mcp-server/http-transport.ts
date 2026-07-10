/**
 * Streamable-HTTP transport wiring for the Fusion operator MCP server
 * (FUSI-003). `buildMcpServer()` (packages/cli/src/mcp-server/server.ts) is
 * transport-agnostic by design — it exposes `connect(transport)` — so this
 * module owns everything that is specific to serving that transport over a
 * network socket instead of stdio: the Node `http.createServer` listener,
 * the SDK's `StreamableHTTPServerTransport`, and the auth/binding guardrails
 * a network-facing surface requires.
 *
 * FNXC:McpServer 2026-07-10-23:00:
 * `fn mcp serve --transport stdio` (FUSI-001/FUSI-002) is deliberately
 * unauthenticated: stdio is a same-machine pipe the operator's own shell
 * launched, so the caller already had to have OS-level access to spawn the
 * process. That trust model does NOT transfer to HTTP — a streamable-HTTP
 * listener is reachable from any process (or, if misconfigured, any host)
 * that can open a TCP connection to the bound port. This module therefore
 * re-derives the trust boundary from scratch instead of inheriting stdio's
 * "no additional auth" assumption:
 *   1. Binds to `127.0.0.1` (loopback) by default — never `0.0.0.0`/a LAN
 *      address unless the operator explicitly passes `--host`.
 *   2. Requires a bearer token for EVERY request (`Authorization: Bearer`
 *      header, with a `?token=` query fallback mirroring
 *      packages/dashboard/src/auth-middleware.ts's `extractTokenFromRequest`
 *      shape — read-only reference, not an import; this module stays
 *      self-contained in the CLI package).
 *   3. REFUSES to start (throws before `listen`) when the resolved bind
 *      host is non-loopback and no token is configured — a networked
 *      operator server must never run open. Loopback-with-no-token is
 *      still permitted (e.g. quick local smoke testing) but emits a stderr
 *      warning recommending a token, since even loopback is reachable by
 *      any other local user/process on multi-tenant hosts.
 * Tool allow-list, secret redaction, and release/*_delete exclusions are
 * all inherited unchanged from the `McpServer` `buildMcpServer()` builds —
 * this module never registers additional tools.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FusionMcpServer } from "./server.js";

export interface StartHttpMcpTransportOptions {
  /** The curated Fusion `McpServer` (from `buildMcpServer()`) to serve over HTTP. */
  server: FusionMcpServer;
  /** Bind host. Defaults to loopback (`127.0.0.1`). */
  host?: string;
  /** Bind port. Required — pass `0` for an OS-assigned ephemeral port (tests). */
  port: number;
  /** Bearer token required on every request. */
  token?: string;
  /** Override stderr sink for tests (defaults to `console.error`). */
  logger?: (message: string) => void;
}

export interface HttpMcpTransportHandle {
  /** The underlying Node HTTP server. */
  httpServer: Server;
  /** The SDK streamable-HTTP transport connected to the Fusion `McpServer`. */
  transport: StreamableHTTPServerTransport;
  /** Resolved bind address (host:port) once listening. */
  address: { host: string; port: number };
  /** Closes the HTTP listener and the streamable-HTTP transport. Does NOT close the McpServer or TaskStore — callers own that lifecycle. */
  close: () => Promise<void>;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/**
 * Constant-time bearer-token compare, mirroring
 * packages/dashboard/src/auth-middleware.ts's `constantTimeEqual`: reject
 * up front on length mismatch (a length check is not a meaningful timing
 * oracle — the token length itself is not the secret), then run
 * `timingSafeEqual` over equal-length buffers so a byte-by-byte early exit
 * comparison can never leak how many leading bytes matched.
 */
function constantTimeTokenEqual(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  try {
    return timingSafeEqual(providedBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

/**
 * Extract a bearer token from either the `Authorization: Bearer <token>`
 * header or a `?token=` query-string fallback (mirrors the dashboard's
 * `fn_token` query param pattern, using `token` here since this is a
 * separate, self-contained module with its own query-param namespace).
 */
function extractBearerToken(req: IncomingMessage): string | undefined {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length);
  }
  if (req.url) {
    try {
      const parsed = new URL(req.url, "http://_placeholder_");
      const fromQuery = parsed.searchParams.get("token");
      if (fromQuery) return fromQuery;
    } catch {
      // Malformed URL — treat as no token.
    }
  }
  return undefined;
}

function sendUnauthorized(res: ServerResponse): void {
  // FNXC:McpServer 2026-07-10-23:00: No body leakage on 401 — do not echo
  // back the offending token, the expected length, or any request detail.
  res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "Unauthorized" }));
}

/**
 * Starts a Node HTTP listener that serves the given Fusion `McpServer` over
 * `StreamableHTTPServerTransport`, enforcing the loopback-default +
 * mandatory-bearer-token policy described in the module header. Throws
 * BEFORE binding a socket if the resolved host is non-loopback and no
 * token is configured.
 */
export async function startHttpMcpTransport(options: StartHttpMcpTransportOptions): Promise<HttpMcpTransportHandle> {
  const { server, port, token } = options;
  const host = options.host && options.host.trim().length > 0 ? options.host.trim() : "127.0.0.1";
  const log = options.logger ?? ((message: string) => console.error(message));

  const loopback = isLoopbackHost(host);
  if (!loopback && !token) {
    throw new Error(
      `[fn mcp serve] refusing to bind non-loopback host "${host}" without a bearer token. ` +
        "Pass --token <t> or set FN_MCP_TOKEN, or omit --host to bind loopback only.",
    );
  }
  if (loopback && !token) {
    log(
      "[fn mcp serve] WARNING: HTTP transport is running on loopback with NO bearer token configured. " +
        "Any local process/user can reach it. Set --token <t> or FN_MCP_TOKEN to require authentication.",
    );
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(transport);

  const httpServer = createServer((req, res) => {
    // FNXC:McpServer 2026-07-10-23:00: Diagnostics for the HTTP path go to
    // stderr only — MCP protocol bytes for the HTTP transport flow over
    // the HTTP response body, never stdout (stdout is reserved for the
    // stdio transport's JSON-RPC framing and must stay clean).
    if (token && !constantTimeTokenEqual(extractBearerToken(req) ?? "", token)) {
      sendUnauthorized(res);
      return;
    }
    // Loopback-with-no-token: request allowed through (warned about at startup).
    void transport.handleRequest(req, res).catch((error) => {
      log(`[fn mcp serve] error handling HTTP MCP request: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "Internal Server Error" }));
      }
    });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    httpServer.once("error", rejectPromise);
    httpServer.listen(port, host, () => {
      httpServer.removeListener("error", rejectPromise);
      resolvePromise();
    });
  });

  const resolvedAddress = httpServer.address();
  const resolvedPort = resolvedAddress && typeof resolvedAddress === "object" ? resolvedAddress.port : port;
  log(
    `[fn mcp serve] Fusion MCP operator server listening on http://${host}:${resolvedPort} ` +
      (token ? "(bearer token required)" : "(NO AUTH — loopback only)"),
  );

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolveClose) => {
      httpServer.close(() => resolveClose());
    });
    await transport.close();
  };

  return {
    httpServer,
    transport,
    address: { host, port: resolvedPort },
    close,
  };
}
