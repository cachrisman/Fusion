/**
 * FNXC:McpServer 2026-07-10-23:20:
 * FUSI-003 coverage for the streamable-HTTP MCP transport. Binds a real
 * in-process Node HTTP listener to `127.0.0.1:0` (ephemeral port — never
 * port 4040, per AGENTS.md) and drives it with the SDK's real
 * `StreamableHTTPClientTransport` + `Client`, so this exercises the actual
 * wire protocol (auth header parsing, request/response framing) rather than
 * calling internals directly. Asserts:
 *   - unauthenticated/wrong-token requests get 401
 *   - a correctly authenticated request completes initialize + tools/list
 *   - the HTTP tool set is byte-for-byte parity with the FUSI-001 curated
 *     stdio allow-list (no extra tools registered for the HTTP path)
 *   - non-loopback bind without a token is refused before listening
 *   - loopback bind without a token starts but warns
 *   - wrong-but-same-length and wrong-length tokens are both rejected
 *   - close() tears down the listener and TaskStore handle cleanly
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "@fusion/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_TOOL_REGISTRY } from "../tools.js";
import { buildMcpServer, type FusionMcpServer } from "../server.js";
import { startHttpMcpTransport, type HttpMcpTransportHandle } from "../http-transport.js";

const EXPECTED_TOOL_NAMES = MCP_TOOL_REGISTRY.map((t) => t.name).sort();
const FORBIDDEN_NAME_PATTERNS = [/release/i, /publish/i, /version[-_]?tag/i, /changeset/i];

const TEST_TOKEN = "test-bearer-token-abc123";

describe("startHttpMcpTransport (FUSI-003)", () => {
  let tmpDir: string;
  let store: TaskStore;
  let mcpServer: FusionMcpServer | undefined;
  let handle: HttpMcpTransportHandle | undefined;
  let stderrLines: string[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "fn-fusi-003-mcp-http-"));
    await mkdir(join(tmpDir, ".fusion"), { recursive: true });
    store = new TaskStore(tmpDir);
    await store.init();
    stderrLines = [];
  });

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
    if (mcpServer) {
      await mcpServer.close();
      mcpServer = undefined;
    }
    await store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function logger(message: string): void {
    stderrLines.push(message);
  }

  async function startServer(options: { token?: string; host?: string } = {}): Promise<HttpMcpTransportHandle> {
    mcpServer = buildMcpServer({ cwd: tmpDir, store, version: "test" });
    handle = await startHttpMcpTransport({
      server: mcpServer,
      host: options.host ?? "127.0.0.1",
      port: 0,
      token: options.token,
      logger,
    });
    return handle;
  }

  function baseUrl(h: HttpMcpTransportHandle): URL {
    return new URL(`http://${h.address.host}:${h.address.port}/`);
  }

  async function connectAuthedClient(h: HttpMcpTransportHandle, token: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(baseUrl(h), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "test-http-client", version: "1.0.0" });
    await client.connect(transport);
    return client;
  }

  it("rejects a request with no bearer token (401)", async () => {
    const h = await startServer({ token: TEST_TOKEN });
    const res = await fetch(new URL("mcp", baseUrl(h)), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a request with an incorrect bearer token (401)", async () => {
    const h = await startServer({ token: TEST_TOKEN });
    const res = await fetch(new URL("mcp", baseUrl(h)), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong-token-here" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong-but-same-length token", async () => {
    const h = await startServer({ token: TEST_TOKEN });
    const sameLengthWrong = "x".repeat(TEST_TOKEN.length);
    const res = await fetch(new URL("mcp", baseUrl(h)), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sameLengthWrong}` },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong-length token", async () => {
    const h = await startServer({ token: TEST_TOKEN });
    const res = await fetch(new URL("mcp", baseUrl(h)), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer short" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it("completes initialize + tools/list with a correct bearer token, with parity to the stdio curated allow-list", async () => {
    const h = await startServer({ token: TEST_TOKEN });
    const client = await connectAuthedClient(h, TEST_TOKEN);
    try {
      const { tools } = await client.listTools();
      const names = (tools ?? []).map((t) => t.name).sort();
      expect(names).toEqual(EXPECTED_TOOL_NAMES);
      for (const pattern of FORBIDDEN_NAME_PATTERNS) {
        expect(names.some((name) => pattern.test(name))).toBe(false);
      }
      expect(names.some((name) => /_delete$/i.test(name))).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("accepts a ?token= query-string fallback", async () => {
    const h = await startServer({ token: TEST_TOKEN });
    const url = baseUrl(h);
    url.pathname = "mcp";
    url.searchParams.set("token", TEST_TOKEN);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json, text/event-stream", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        id: 1,
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "query-token-test", version: "1.0.0" },
        },
      }),
    });
    expect(res.status).not.toBe(401);
  });

  it("refuses to start on a non-loopback host with no token configured", async () => {
    mcpServer = buildMcpServer({ cwd: tmpDir, store, version: "test" });
    await expect(
      startHttpMcpTransport({ server: mcpServer, host: "0.0.0.0", port: 0, logger }),
    ).rejects.toThrow(/refusing to bind non-loopback/i);
  });

  it("allows a non-loopback host when a token is configured", async () => {
    mcpServer = buildMcpServer({ cwd: tmpDir, store, version: "test" });
    handle = await startHttpMcpTransport({ server: mcpServer, host: "0.0.0.0", port: 0, token: TEST_TOKEN, logger });
    expect(handle.address.host).toBe("0.0.0.0");
  });

  it("starts on loopback with no token but emits a warning", async () => {
    await startServer({});
    expect(stderrLines.some((line) => /WARNING/i.test(line) && /no bearer token/i.test(line))).toBe(true);
  });

  it("does not warn when loopback has a token configured", async () => {
    await startServer({ token: TEST_TOKEN });
    expect(stderrLines.some((line) => /WARNING/i.test(line))).toBe(false);
  });

  it("closes the HTTP listener and refuses new connections after close()", async () => {
    const h = await startServer({ token: TEST_TOKEN });
    const url = baseUrl(h);
    await h.close();
    handle = undefined;
    await expect(fetch(new URL("mcp", url), { method: "GET" })).rejects.toThrow();
  });
});
