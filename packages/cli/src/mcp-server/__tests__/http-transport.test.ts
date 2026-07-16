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
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { TaskStore } from "@fusion/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MCP_TOOL_REGISTRY, buildMcpToolRegistry } from "../tools.js";
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

  async function startServer(options: { token?: string; host?: string; allowDestructive?: boolean } = {}): Promise<HttpMcpTransportHandle> {
    mcpServer = buildMcpServer({ cwd: tmpDir, store, version: "test", allowDestructive: options.allowDestructive });
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

  /**
   * FNXC:McpServer 2026-07-11-00:05: `fetch`/undici refuses to let callers
   * override the `Host` request header (it always derives Host from the
   * URL being fetched), so forging a DNS-rebinding-style foreign `Host`
   * header requires the raw `node:http` client instead of `fetch`. This
   * mirrors exactly what a rebound browser connection looks like on the
   * wire: a TCP connection to the loopback listener carrying a `Host`
   * header for a different hostname.
   */
  function rawRequest(
    h: HttpMcpTransportHandle,
    options: { path?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ status: number }> {
    return new Promise((resolvePromise, rejectPromise) => {
      const req = httpRequest(
        {
          host: h.address.host,
          port: h.address.port,
          path: options.path ?? "/mcp",
          method: "POST",
          headers: { "content-type": "application/json", ...options.headers },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolvePromise({ status: res.statusCode ?? 0 }));
        },
      );
      req.on("error", rejectPromise);
      req.end(options.body ?? JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }));
    });
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

  it("matches in-memory tool names and normalized input schemas for both registry flags", async () => {
    async function listInMemory(allowDestructive: boolean) {
      const inMemoryServer = buildMcpServer({ cwd: tmpDir, store, version: "test", allowDestructive });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test-in-memory-client", version: "1.0.0" });
      await Promise.all([client.connect(clientTransport), inMemoryServer.connect(serverTransport)]);
      try {
        return (await client.listTools()).tools ?? [];
      } finally {
        await client.close();
        await inMemoryServer.close();
      }
    }

    for (const allowDestructive of [false, true]) {
      const h = await startServer({ token: TEST_TOKEN, allowDestructive });
      const client = await connectAuthedClient(h, TEST_TOKEN);
      try {
        const httpTools = (await client.listTools()).tools ?? [];
        const inMemoryTools = await listInMemory(allowDestructive);
        const normalize = (tools: Array<{ name: string; inputSchema: unknown }>) => tools
          .map(({ name, inputSchema }) => ({ name, inputSchema }))
          .sort((a, b) => a.name.localeCompare(b.name));
        expect(normalize(httpTools)).toEqual(normalize(inMemoryTools));
        expect(httpTools).toHaveLength(allowDestructive ? 89 : 78);
        expect(httpTools.map((tool) => tool.name).sort()).toEqual(buildMcpToolRegistry({ allowDestructive }).map((tool) => tool.name).sort());
      } finally {
        await client.close();
        await h.close();
        handle = undefined;
        mcpServer = undefined;
      }
    }
  });

  it("enforces bounded schemas and returns safe workflow conflicts before HTTP dispatch can expose internals", async () => {
    const marker = "workflow-input:sk-live-marker-secret@1: private executor state";
    const task = await store.createTask({ description: "HTTP contract task", source: { sourceType: "api" } });
    await store.updateTask(task.id, { paused: true, status: "awaiting-user-input", pausedReason: `${marker}-replaced` });
    const h = await startServer({ token: TEST_TOKEN });
    const client = await connectAuthedClient(h, TEST_TOKEN);
    try {
      const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
      for (const args of [
        { task_id: task.id, expected_input_marker: marker },
        { task_id: task.id, text: "", expected_input_marker: marker },
        { task_id: task.id, text: "x".repeat(2_001), expected_input_marker: marker },
        { task_id: task.id, text: 7, expected_input_marker: marker },
      ]) {
        const result = await call("fn_task_workflow_input", args);
        expect(result.isError).toBe(true);
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain("sk-live-marker-secret");
        expect(serialized).not.toMatch(/stack|\/private\//i);
      }

      for (const args of [{ task_id: task.id, limit: -1 }, { task_id: task.id, limit: 101 }, { task_id: task.id, offset: -1 }, { task_id: task.id, offset: 10_001 }]) {
        expect((await call("fn_task_comments_list", args)).isError).toBe(true);
      }
      expect((await call("fn_task_comments_list", { task_id: task.id, limit: 100, offset: 0 })).isError).not.toBe(true);
      expect((await call("fn_task_comments_create", { task_id: task.id, text: "x" })).isError).not.toBe(true);
      expect((await call("fn_task_comments_create", { task_id: task.id, text: "x".repeat(2_000) })).isError).not.toBe(true);
      expect((await call("fn_task_workflow_input", { task_id: task.id, text: "x", expected_input_marker: marker })).isError).toBe(true);
      const invalidWorkflow = await call("fn_workflow_validate", { ir: { version: "v2", nodes: "not-an-array" } });
      expect((invalidWorkflow.structuredContent as { valid?: boolean }).valid).toBe(false);
      expect(JSON.stringify(invalidWorkflow)).not.toMatch(/stack|\/private\//i);
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

  describe("DNS-rebinding protection (FUSI-047)", () => {
    it("rejects a foreign Host header on a loopback no-token server (403)", async () => {
      const h = await startServer({});
      const res = await rawRequest(h, { headers: { Host: "evil.example:1234" } });
      expect(res.status).toBe(403);
    });

    it("rejects a foreign Host header on a loopback WITH-token server (403, independent of token check)", async () => {
      const h = await startServer({ token: TEST_TOKEN });
      const res = await rawRequest(h, {
        headers: { Host: "evil.example:1234", authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(res.status).toBe(403);
    });

    it("allows a legitimate loopback Host header through (no regression)", async () => {
      const h = await startServer({ token: TEST_TOKEN });
      const res = await rawRequest(h, {
        headers: { Host: `127.0.0.1:${h.address.port}`, authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(res.status).not.toBe(403);
    });

    /**
     * FNXC:McpServer 2026-07-11-00:10: A well-formed HTTP/1.1 client
     * always sends `Host` (Node's own HTTP/1.1 parser rejects a request
     * without one with 400 before our handler even runs), so to reach
     * this module's own "missing Host" branch this test speaks raw
     * HTTP/1.0 over a socket (HTTP/1.0 does not require `Host`), landing
     * on `req.headers.host === undefined` and exercising our explicit
     * treat-absent-as-untrusted guard rather than Node's parser-level 400.
     */
    it("rejects a missing Host header on a loopback bind (403)", async () => {
      const h = await startServer({});
      const status = await new Promise<number>((resolvePromise, rejectPromise) => {
        const socket = netConnect(h.address.port, h.address.host, () => {
          socket.write('POST /mcp HTTP/1.0\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}');
        });
        let statusLine = "";
        socket.on("data", (chunk) => {
          if (!statusLine) statusLine = chunk.toString();
        });
        socket.on("close", () => {
          const match = statusLine.match(/^HTTP\/1\.\d (\d{3})/);
          resolvePromise(match ? Number(match[1]) : 0);
        });
        socket.on("error", rejectPromise);
      });
      expect(status).toBe(403);
    });

    it("rejects a foreign Origin header on a loopback bind (403)", async () => {
      const h = await startServer({});
      const res = await rawRequest(h, {
        headers: { Host: `127.0.0.1:${h.address.port}`, origin: "http://evil.example" },
      });
      expect(res.status).toBe(403);
    });

    it("allows an absent Origin header on a loopback bind (native MCP clients omit Origin)", async () => {
      const h = await startServer({ token: TEST_TOKEN });
      const res = await rawRequest(h, {
        headers: { Host: `127.0.0.1:${h.address.port}`, authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(res.status).not.toBe(403);
    });

    it("allows a loopback Origin header through", async () => {
      const h = await startServer({ token: TEST_TOKEN });
      const res = await rawRequest(h, {
        headers: {
          Host: `127.0.0.1:${h.address.port}`,
          origin: `http://127.0.0.1:${h.address.port}`,
          authorization: `Bearer ${TEST_TOKEN}`,
        },
      });
      expect(res.status).not.toBe(403);
    });

    it("does NOT apply the Host allow-list on a non-loopback bind (existing --host + token path preserved)", async () => {
      mcpServer = buildMcpServer({ cwd: tmpDir, store, version: "test" });
      handle = await startHttpMcpTransport({
        server: mcpServer,
        host: "0.0.0.0",
        port: 0,
        token: TEST_TOKEN,
        logger,
      });
      const res = await rawRequest(handle, {
        headers: { Host: "evil.example:1234", authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(res.status).not.toBe(403);
    });
  });
});
