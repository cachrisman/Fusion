// @vitest-environment node

/*
 * FNXC:McpConfig 2026-07-12-00:00:
 * Route-layer tests for the dashboard-hosted interactive MCP OAuth authorize/callback dance (FUSI-075). The
 * SDK-driven PKCE/DCR/metadata-discovery logic is covered at the engine layer
 * (packages/engine/src/mcp-oauth-authorize.test.ts); these tests instead assert the dashboard's own
 * responsibilities: resolving the raw server definition from settings, minting/validating the CSRF `state`
 * (missing/invalid/replayed all rejected), persisting the returned client-info/token bundle as Fusion secret
 * refs via `updateSettings`/`updateGlobalSettings`, rejecting non-oauth server definitions, and never leaking
 * code/token/url material into a response body.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createApiRoutes } from "../routes.js";
import { request } from "../test-request.js";
import type { McpServerDefinition } from "@fusion/core";

const engineMocks = vi.hoisted(() => ({
  resolveMcpServersForRuntime: vi.fn(),
  startMcpOAuthAuthorize: vi.fn(),
  completeMcpOAuthCallback: vi.fn(),
}));

vi.mock("@fusion/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/engine")>();
  return {
    ...actual,
    createFnAgent: vi.fn(),
    getExemptToolNames: vi.fn(() => []),
    promptWithFallback: vi.fn(),
    reloadExemptTools: vi.fn(),
    resolveIntegrationBranch: vi.fn(() => "main"),
    resolveMcpServersForRuntime: engineMocks.resolveMcpServersForRuntime,
    startMcpOAuthAuthorize: engineMocks.startMcpOAuthAuthorize,
    completeMcpOAuthCallback: engineMocks.completeMcpOAuthCallback,
  };
});

interface FakeSecretRecord {
  id: string;
  scope: "global" | "project";
  key: string;
}

function createFakeSecretsStore() {
  const secrets = new Map<string, FakeSecretRecord & { plaintextValue: string }>();
  let counter = 0;
  return {
    listSecrets(scope?: "global" | "project") {
      return [...secrets.values()].filter((s) => scope === undefined || s.scope === scope);
    },
    async createSecret(input: { scope: "global" | "project"; key: string; plaintextValue: string }) {
      counter += 1;
      const id = `secret-${counter}`;
      secrets.set(id, { id, scope: input.scope, key: input.key, plaintextValue: input.plaintextValue });
      return { id, key: input.key, scope: input.scope };
    },
    async updateSecret(id: string, _scope: "global" | "project", patch: { plaintextValue?: string }) {
      const existing = secrets.get(id);
      if (existing && patch.plaintextValue !== undefined) existing.plaintextValue = patch.plaintextValue;
      return existing;
    },
    async revealSecret(id: string) {
      const existing = secrets.get(id);
      if (!existing) throw new Error("secret not found");
      return { key: existing.key, plaintextValue: existing.plaintextValue };
    },
    _debugSecrets: secrets,
  };
}

function createMockStore(initial: {
  global?: { enabled: boolean; servers: McpServerDefinition[] };
  project?: { enabled: boolean; servers: McpServerDefinition[] };
} = {}) {
  const state = {
    global: initial.global ?? { enabled: true, servers: [] },
    project: initial.project ?? { enabled: true, servers: [] },
  };
  const secretsStore = createFakeSecretsStore();
  return {
    getRootDir: () => "/repo",
    getSecretsStore: async () => secretsStore,
    async getSettingsByScopeFast() {
      return { global: { mcpServers: state.global }, project: { mcpServers: state.project } };
    },
    async updateGlobalSettings(patch: { mcpServers?: { enabled: boolean; servers: McpServerDefinition[] } }) {
      if (patch.mcpServers) state.global = patch.mcpServers;
      return {} as never;
    },
    async updateSettings(patch: { mcpServers?: { enabled: boolean; servers: McpServerDefinition[] } }) {
      if (patch.mcpServers) state.project = patch.mcpServers;
      return {} as never;
    },
    _debugState: state,
    _debugSecretsStore: secretsStore,
  };
}

function createApp(store: ReturnType<typeof createMockStore>) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store as never));
  return app;
}

const OAUTH_SSE_SERVER: McpServerDefinition = {
  name: "sse-oauth",
  transport: "sse",
  url: "https://mcp.example.test/sse",
  auth: { type: "oauth", authorizationServerUrl: "https://auth.example.test" },
};

const OAUTH_STREAMABLE_SERVER: McpServerDefinition = {
  name: "streamable-oauth",
  transport: "streamable-http",
  url: "https://mcp.example.test/mcp",
  auth: { type: "oauth", authorizationServerUrl: "https://auth.example.test", clientId: "pre-registered" },
};

const STDIO_SERVER: McpServerDefinition = { name: "local-stdio", transport: "stdio", command: "node" };

function resolvedFor(server: McpServerDefinition) {
  return { ...server };
}

describe("POST /api/mcp/oauth/authorize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts authorize for an sse oauth server and returns only the authorization URL", async () => {
    const store = createMockStore({ project: { enabled: true, servers: [OAUTH_SSE_SERVER] } });
    engineMocks.resolveMcpServersForRuntime.mockResolvedValue({ servers: [resolvedFor(OAUTH_SSE_SERVER)], errors: [] });
    engineMocks.startMcpOAuthAuthorize.mockResolvedValue({ authorizationUrl: "https://auth.example.test/authorize?state=abc&code_challenge=xyz" });

    const app = createApp(store);
    const response = await request(
      app,
      "POST",
      "/api/mcp/oauth/authorize",
      JSON.stringify({ scope: "project", name: "sse-oauth" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ authorizationUrl: "https://auth.example.test/authorize?state=abc&code_challenge=xyz" });
    expect(engineMocks.startMcpOAuthAuthorize).toHaveBeenCalledTimes(1);
    const [, opts] = engineMocks.startMcpOAuthAuthorize.mock.calls[0]!;
    expect(typeof opts.state).toBe("string");
    expect(opts.state.length).toBeGreaterThan(0);
    expect(opts.redirectUri).toContain("/api/mcp/oauth/callback");
  });

  it("starts authorize for a streamable-http oauth server with a pre-registered clientId", async () => {
    const store = createMockStore({ global: { enabled: true, servers: [OAUTH_STREAMABLE_SERVER] } });
    engineMocks.resolveMcpServersForRuntime.mockResolvedValue({ servers: [resolvedFor(OAUTH_STREAMABLE_SERVER)], errors: [] });
    engineMocks.startMcpOAuthAuthorize.mockResolvedValue({ authorizationUrl: "https://auth.example.test/authorize?state=def&client_id=pre-registered" });

    const app = createApp(store);
    const response = await request(
      app,
      "POST",
      "/api/mcp/oauth/authorize",
      JSON.stringify({ scope: "global", name: "streamable-oauth" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ authorizationUrl: "https://auth.example.test/authorize?state=def&client_id=pre-registered" });
  });

  it("rejects a stdio (non-oauth) server definition", async () => {
    const store = createMockStore({ project: { enabled: true, servers: [STDIO_SERVER] } });
    const app = createApp(store);
    const response = await request(
      app,
      "POST",
      "/api/mcp/oauth/authorize",
      JSON.stringify({ scope: "project", name: "local-stdio" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(400);
    expect(engineMocks.startMcpOAuthAuthorize).not.toHaveBeenCalled();
  });

  it("rejects a server name that is not configured in the given scope", async () => {
    const store = createMockStore();
    const app = createApp(store);
    const response = await request(
      app,
      "POST",
      "/api/mcp/oauth/authorize",
      JSON.stringify({ scope: "project", name: "missing" }),
      { "content-type": "application/json" },
    );
    expect(response.status).toBe(400);
  });

  it("never leaks token/url material into the response body beyond the authorization URL itself", async () => {
    const store = createMockStore({ project: { enabled: true, servers: [OAUTH_SSE_SERVER] } });
    engineMocks.resolveMcpServersForRuntime.mockResolvedValue({ servers: [resolvedFor(OAUTH_SSE_SERVER)], errors: [] });
    engineMocks.startMcpOAuthAuthorize.mockResolvedValue({ authorizationUrl: "https://auth.example.test/authorize?state=abc" });

    const app = createApp(store);
    const response = await request(
      app,
      "POST",
      "/api/mcp/oauth/authorize",
      JSON.stringify({ scope: "project", name: "sse-oauth" }),
      { "content-type": "application/json" },
    );

    expect(Object.keys(response.body as Record<string, unknown>)).toEqual(["authorizationUrl"]);
  });
});

describe("GET /api/mcp/oauth/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function startFlow(store: ReturnType<typeof createMockStore>, server: McpServerDefinition) {
    engineMocks.resolveMcpServersForRuntime.mockResolvedValue({ servers: [resolvedFor(server)], errors: [] });
    engineMocks.startMcpOAuthAuthorize.mockResolvedValue({ authorizationUrl: "https://auth.example.test/authorize?state=abc" });
    const app = createApp(store);
    const scope = store._debugState.project.servers.some((s) => s.name === server.name) ? "project" : "global";
    const startResponse = await request(
      app,
      "POST",
      "/api/mcp/oauth/authorize",
      JSON.stringify({ scope, name: server.name }),
      { "content-type": "application/json" },
    );
    expect(startResponse.status).toBe(200);
    const [, opts] = engineMocks.startMcpOAuthAuthorize.mock.calls[0]!;
    return { app, state: opts.state as string };
  }

  it("completes the callback, persists the token bundle as secret refs, and never echoes the code/state", async () => {
    const store = createMockStore({ project: { enabled: true, servers: [OAUTH_SSE_SERVER] } });
    const { app, state } = await startFlow(store, OAUTH_SSE_SERVER);

    engineMocks.completeMcpOAuthCallback.mockImplementation(async (_server, opts) => {
      await opts.store.saveTokens("sse-oauth", { accessToken: "issued-access-token", refreshToken: "issued-refresh-token", expiresAt: Date.now() + 3600_000 });
      return { ok: true };
    });

    const response = await request(app, "GET", `/api/mcp/oauth/callback?code=auth-code&state=${encodeURIComponent(state)}`);

    expect(response.status).toBe(200);
    const bodyText = response.body as unknown as string;
    expect(String(bodyText)).not.toContain("auth-code");
    expect(String(bodyText)).not.toContain("issued-access-token");
    expect(String(bodyText)).not.toContain(state);

    const persistedServer = store._debugState.project.servers.find((s) => s.name === "sse-oauth")!;
    expect(persistedServer.transport).not.toBe("stdio");
    const auth = (persistedServer as { auth?: { accessToken?: unknown; refreshToken?: unknown } }).auth;
    expect(auth?.accessToken).toMatchObject({ secretRef: expect.any(String), scope: "project" });
    expect(auth?.refreshToken).toMatchObject({ secretRef: expect.any(String), scope: "project" });
    const revealed = await store._debugSecretsStore.revealSecret((auth!.accessToken as { secretRef: string }).secretRef);
    expect(revealed.plaintextValue).toBe("issued-access-token");
  });

  it("performs DCR persistence: saveClientInformation persists a DCR-issued clientSecret as a secret ref", async () => {
    const store = createMockStore({ global: { enabled: true, servers: [{ ...OAUTH_SSE_SERVER, name: "dcr-oauth" }] } });
    const { app, state } = await startFlow(store, { ...OAUTH_SSE_SERVER, name: "dcr-oauth" });

    engineMocks.completeMcpOAuthCallback.mockImplementation(async (_server, opts) => {
      await opts.store.saveClientInformation("dcr-oauth", { client_id: "dcr-client-id", client_secret: "dcr-client-secret" });
      await opts.store.saveTokens("dcr-oauth", { accessToken: "tok", expiresAt: Date.now() + 1000 });
      return { ok: true };
    });

    const response = await request(app, "GET", `/api/mcp/oauth/callback?code=auth-code&state=${encodeURIComponent(state)}`);
    expect(response.status).toBe(200);

    const persistedServer = store._debugState.global.servers.find((s) => s.name === "dcr-oauth")! as McpServerDefinition & { auth?: { clientId?: string; clientSecret?: unknown } };
    expect(persistedServer.auth?.clientId).toBe("dcr-client-id");
    expect(persistedServer.auth?.clientSecret).toMatchObject({ secretRef: expect.any(String), scope: "global" });
  });

  it("rejects a missing state", async () => {
    const store = createMockStore();
    const app = createApp(store);
    const response = await request(app, "GET", "/api/mcp/oauth/callback?code=auth-code");
    expect(response.status).toBe(400);
    expect(engineMocks.completeMcpOAuthCallback).not.toHaveBeenCalled();
  });

  it("rejects an invalid/unknown state", async () => {
    const store = createMockStore();
    const app = createApp(store);
    const response = await request(app, "GET", "/api/mcp/oauth/callback?code=auth-code&state=never-issued");
    expect(response.status).toBe(400);
    expect(engineMocks.completeMcpOAuthCallback).not.toHaveBeenCalled();
  });

  it("rejects a replayed callback — the same state cannot be consumed twice", async () => {
    const store = createMockStore({ project: { enabled: true, servers: [OAUTH_SSE_SERVER] } });
    const { app, state } = await startFlow(store, OAUTH_SSE_SERVER);
    engineMocks.completeMcpOAuthCallback.mockResolvedValue({ ok: true });

    const first = await request(app, "GET", `/api/mcp/oauth/callback?code=auth-code&state=${encodeURIComponent(state)}`);
    expect(first.status).toBe(200);

    const second = await request(app, "GET", `/api/mcp/oauth/callback?code=auth-code-2&state=${encodeURIComponent(state)}`);
    expect(second.status).toBe(400);
    expect(engineMocks.completeMcpOAuthCallback).toHaveBeenCalledTimes(1);
  });

  it("rejects a callback for a non-oauth (stdio) server definition even with a valid state shape", async () => {
    // A state can only ever be minted against an oauth server (authorize route rejects stdio upfront), so this
    // asserts the callback's own defense-in-depth check when the underlying server definition changed between
    // authorize-start and callback (e.g. concurrently edited to stdio).
    const store = createMockStore({ project: { enabled: true, servers: [OAUTH_SSE_SERVER] } });
    const { app, state } = await startFlow(store, OAUTH_SSE_SERVER);
    // Simulate the server having been reconfigured to stdio (same name) between authorize-start and callback.
    store._debugState.project.servers = [{ name: "sse-oauth", transport: "stdio", command: "node" }];

    const response = await request(app, "GET", `/api/mcp/oauth/callback?code=auth-code&state=${encodeURIComponent(state)}`);
    expect(response.status).toBe(400);
    expect(engineMocks.completeMcpOAuthCallback).not.toHaveBeenCalled();
  });
});
