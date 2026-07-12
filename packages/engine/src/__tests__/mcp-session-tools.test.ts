import { describe, expect, it, vi } from "vitest";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ResolvedMcpOAuthAuth, ResolvedMcpServerDefinition } from "@fusion/core";
import { connectMcpSessionTools, uniqueMcpToolName, type McpSessionClient } from "../mcp-session-tools.js";
import { FusionMcpOAuthProvider } from "../mcp-oauth-provider.js";

const refreshAuthorizationMock = vi.fn();
vi.mock("@modelcontextprotocol/sdk/client/auth.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, refreshAuthorization: (...args: unknown[]) => refreshAuthorizationMock(...args) };
});

function stdioServer(name: string, enabled = true): ResolvedMcpServerDefinition {
  return { name, transport: "stdio", command: "fake", enabled };
}

function oauthAuth(overrides: Partial<ResolvedMcpOAuthAuth> = {}): ResolvedMcpOAuthAuth {
  return {
    type: "oauth",
    authorizationServerUrl: "https://auth.example.test",
    clientId: "client-1",
    accessToken: "access-token-value",
    refreshToken: "refresh-token-value",
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

/** A fake session client that simulates the SDK's internal `authProvider.tokens()` call before the first request. */
function fakeOAuthAwareClient(toolNames: string[] = []): McpSessionClient & { capturedTransport?: Transport } {
  const client = {
    capturedTransport: undefined as Transport | undefined,
    connect: vi.fn(async (transport: Transport) => {
      client.capturedTransport = transport;
      const authProvider = (transport as unknown as { _authProvider?: { tokens(): Promise<unknown> } })._authProvider;
      if (authProvider) {
        await authProvider.tokens();
      }
    }),
    listTools: vi.fn(async () => ({ tools: toolNames.map((name) => ({ name })) })),
    callTool: vi.fn(async () => ({ content: [] })),
    close: vi.fn(async () => undefined),
  };
  return client;
}

function fakeClient(toolNames: string[], calls: string[] = []): McpSessionClient {
  return {
    connect: vi.fn(async () => undefined),
    listTools: vi.fn(async () => ({
      tools: toolNames.map((name) => ({
        name,
        description: `tool ${name}`,
        inputSchema: name === "lookup"
          ? {
              type: "object",
              properties: { topic: { type: "string", description: "Topic to look up" } },
              required: ["topic"],
            }
          : undefined,
      })),
    })),
    callTool: vi.fn(async ({ name, arguments: args }) => {
      calls.push(name);
      if (name === "fail") return { content: [{ type: "text", text: "failed" }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(args ?? {}) }] };
    }),
    close: vi.fn(async () => undefined),
  };
}

const transportFactory = () => ({}) as Transport;

describe("connectMcpSessionTools", () => {
  it("registers namespaced tools and routes calls to the owning MCP client", async () => {
    const calls: string[] = [];
    const client = fakeClient(["lookup"], calls);
    const toolset = await connectMcpSessionTools([stdioServer("context7")], {
      clientFactory: () => client,
      transportFactory,
    });

    expect(toolset.connected).toEqual(["context7"]);
    expect(toolset.tools.map((tool) => tool.name)).toEqual(["mcp__context7__lookup"]);
    expect(toolset.tools[0]!.parameters).toMatchObject({
      type: "object",
      properties: { topic: { type: "string", description: "Topic to look up" } },
      required: ["topic"],
    });
    const result = await toolset.tools[0]!.execute("call", { topic: "mcp" } as never, undefined, undefined, {} as never);
    expect(calls).toEqual(["lookup"]);
    expect(result.content[0].text).toContain("mcp");
    await toolset.dispose();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("maps tool errors without throwing", async () => {
    const toolset = await connectMcpSessionTools([stdioServer("srv")], {
      clientFactory: () => fakeClient(["fail"]),
      transportFactory,
    });

    const result = await toolset.tools[0]!.execute("call", {}, undefined, undefined, {} as never);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("failed");
  });

  it("skips disabled and failed servers while keeping reachable tools", async () => {
    const good = fakeClient(["read"]);
    const bad: McpSessionClient = {
      ...fakeClient([]),
      connect: vi.fn(async () => { throw new Error("offline"); }),
    };
    const toolset = await connectMcpSessionTools([stdioServer("disabled", false), stdioServer("bad"), stdioServer("good")], {
      clientFactory: (server) => server.name === "bad" ? bad : good,
      transportFactory,
    });

    expect(toolset.skipped).toEqual([
      { name: "disabled", reason: "disabled" },
      { name: "bad", reason: "error" },
    ]);
    expect(toolset.tools.map((tool) => tool.name)).toEqual(["mcp__good__read"]);
  });

  it("keeps empty tool-list connections and creates no tools", async () => {
    const toolset = await connectMcpSessionTools([stdioServer("empty")], {
      clientFactory: () => fakeClient([]),
      transportFactory,
    });

    expect(toolset.connected).toEqual(["empty"]);
    expect(toolset.tools).toEqual([]);
  });

  it("deduplicates sanitized server and tool name collisions deterministically", () => {
    const used = new Set<string>();
    expect(uniqueMcpToolName("a.b", "bash", used)).toBe("mcp__a_b__bash");
    expect(uniqueMcpToolName("a_b", "bash", used)).toBe("mcp__a_b__bash__2");
    expect(uniqueMcpToolName("a_b", "read", used)).toBe("mcp__a_b__read");
  });
});

describe("connectMcpSessionTools — OAuth wiring (default transport factory)", () => {
  it("attaches an authProvider for sse servers with a resolved oauth auth block and connects when the token is valid", async () => {
    const client = fakeOAuthAwareClient(["lookup"]);
    const server: Extract<ResolvedMcpServerDefinition, { transport: "sse" }> = {
      name: "sse-oauth",
      transport: "sse",
      url: "https://mcp.example.test/sse",
      auth: oauthAuth(),
    };

    const toolset = await connectMcpSessionTools([server], { clientFactory: () => client });

    expect(toolset.connected).toEqual(["sse-oauth"]);
    expect(toolset.skipped).toEqual([]);
    expect((client.capturedTransport as unknown as { _authProvider?: unknown })._authProvider).toBeInstanceOf(FusionMcpOAuthProvider);
  });

  it("attaches an authProvider for streamable-http servers with a resolved oauth auth block and connects when the token is valid", async () => {
    const client = fakeOAuthAwareClient(["lookup"]);
    const server: Extract<ResolvedMcpServerDefinition, { transport: "streamable-http" }> = {
      name: "http-oauth",
      transport: "streamable-http",
      url: "https://mcp.example.test/mcp",
      auth: oauthAuth(),
    };

    const toolset = await connectMcpSessionTools([server], { clientFactory: () => client });

    expect(toolset.connected).toEqual(["http-oauth"]);
    expect(toolset.skipped).toEqual([]);
    expect((client.capturedTransport as unknown as { _authProvider?: unknown })._authProvider).toBeInstanceOf(FusionMcpOAuthProvider);
  });

  it("skips a server with no valid/refreshable oauth token with an actionable reason, without dropping other tools or crashing", async () => {
    const badClient = fakeOAuthAwareClient([]);
    const goodClient = fakeOAuthAwareClient(["read"]);
    const badServer: Extract<ResolvedMcpServerDefinition, { transport: "streamable-http" }> = {
      name: "no-token",
      transport: "streamable-http",
      url: "https://mcp.example.test/mcp",
      auth: oauthAuth({ accessToken: undefined, refreshToken: undefined }),
    };
    const goodServer = stdioServer("good");

    const toolset = await connectMcpSessionTools([badServer, goodServer], {
      clientFactory: (server) => (server.name === "no-token" ? badClient : goodClient),
    });

    expect(toolset.skipped).toEqual([{ name: "no-token", reason: "oauth: needs re-authorize (no stored token)" }]);
    expect(toolset.connected).toEqual(["good"]);
    expect(toolset.tools.map((tool) => tool.name)).toEqual(["mcp__good__read"]);
  });

  it("skips a server with a failed non-interactive refresh with an actionable reason, without crashing", async () => {
    refreshAuthorizationMock.mockReset().mockRejectedValueOnce(new Error("invalid_grant"));
    const client = fakeOAuthAwareClient([]);
    const server: Extract<ResolvedMcpServerDefinition, { transport: "sse" }> = {
      name: "refresh-failed",
      transport: "sse",
      url: "https://mcp.example.test/sse",
      auth: oauthAuth({ expiresAt: Date.now() - 60_000 }),
    };

    const toolset = await connectMcpSessionTools([server], { clientFactory: () => client });

    expect(toolset.skipped).toEqual([{ name: "refresh-failed", reason: "oauth: needs re-authorize (refresh failed)" }]);
    expect(toolset.connected).toEqual([]);
  });

  it("leaves stdio transports untouched (no authProvider ever attached)", async () => {
    const client = fakeOAuthAwareClient(["read"]);
    const toolset = await connectMcpSessionTools([stdioServer("local")], { clientFactory: () => client });

    expect(toolset.connected).toEqual(["local"]);
    expect((client.capturedTransport as unknown as { _authProvider?: unknown })._authProvider).toBeUndefined();
  });
});

describe("connectMcpSessionTools — real token store wiring (FUSI-076 Step 3)", () => {
  function fullMcpSettingsStore(serverAuth: ResolvedMcpOAuthAuth) {
    const updateCalls: unknown[] = [];
    return {
      updateCalls,
      async getSettingsByScope() {
        return {
          global: { mcpServers: { enabled: true, servers: [] } },
          project: {
            mcpServers: {
              enabled: true,
              servers: [{ name: "sse-oauth", transport: "sse" as const, url: "https://mcp.example.test/sse", auth: serverAuth }],
            },
          },
        };
      },
      async updateSettings(patch: unknown) {
        updateCalls.push(patch);
        return patch;
      },
      async updateGlobalSettings(patch: unknown) {
        updateCalls.push(patch);
        return patch;
      },
      async getSecretsStore() {
        return {
          async revealSecret() {
            throw new Error("unused");
          },
          listSecrets: () => [],
          async createSecret(input: { key: string }) {
            return { id: `secret-${input.key}` };
          },
          async updateSecret() {
            return undefined;
          },
        };
      },
    };
  }

  it("persists a refreshed token via the concrete store when mcpSettingsStore + scopeByServerName are supplied", async () => {
    refreshAuthorizationMock.mockReset().mockResolvedValueOnce({
      access_token: "new-access",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "new-refresh",
    });
    const server: Extract<ResolvedMcpServerDefinition, { transport: "sse" }> = {
      name: "sse-oauth",
      transport: "sse",
      url: "https://mcp.example.test/sse",
      auth: oauthAuth({ expiresAt: Date.now() - 60_000 }),
    };
    const client = fakeOAuthAwareClient(["lookup"]);
    const mcpSettingsStore = fullMcpSettingsStore(server.auth);

    const toolset = await connectMcpSessionTools([server], {
      clientFactory: () => client,
      mcpSettingsStore,
      scopeByServerName: { "sse-oauth": "project" },
    });

    expect(toolset.connected).toEqual(["sse-oauth"]);
    expect(mcpSettingsStore.updateCalls).toHaveLength(1);
  });

  it("falls back to warn-only (no persistence call) when no mcpSettingsStore/oauthTokenStore is supplied", async () => {
    refreshAuthorizationMock.mockReset().mockResolvedValueOnce({
      access_token: "new-access",
      token_type: "Bearer",
      expires_in: 3600,
    });
    const server: Extract<ResolvedMcpServerDefinition, { transport: "sse" }> = {
      name: "sse-oauth",
      transport: "sse",
      url: "https://mcp.example.test/sse",
      auth: oauthAuth({ expiresAt: Date.now() - 60_000 }),
    };
    const client = fakeOAuthAwareClient(["lookup"]);
    const warn = vi.fn();

    const toolset = await connectMcpSessionTools([server], { clientFactory: () => client, logger: { log: vi.fn(), warn } });

    expect(toolset.connected).toEqual(["sse-oauth"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not persisted"));
  });
});
