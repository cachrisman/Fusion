import { describe, expect, it } from "vitest";
import type { McpSecretReader } from "@fusion/core";
import { buildMcpOAuthTokenStore, resolveMcpServersForRuntime, resolveMcpServersForStore } from "../mcp-resolution.js";
import { createHttpMcpTransport, createWarnOnlyMcpOAuthTokenStore, FusionMcpOAuthProvider } from "../mcp-oauth-provider.js";

function secrets(values: Record<string, string>): McpSecretReader {
  return {
    async revealSecret(id) {
      const plaintextValue = values[id];
      if (plaintextValue === undefined) throw new Error(`missing ${id}`);
      return { key: id, plaintextValue };
    },
  };
}

describe("resolveMcpServersForRuntime", () => {
  it("resolves effective settings and materializes secret references", async () => {
    const result = await resolveMcpServersForRuntime({
      globalSettings: {
        mcpServers: {
          enabled: true,
          servers: [
            { name: "global", transport: "stdio", command: "node", args: ["server.js"], env: { API_KEY: { secretRef: "global-key", scope: "global" } } },
          ],
        },
      },
      projectSettings: null,
      secrets: secrets({ "global-key": "SECRET_VALUE" }),
      reader: { agentId: "agent-1" },
    });

    expect(result.errors).toEqual([]);
    expect(result.servers).toEqual([
      { name: "global", transport: "stdio", command: "node", args: ["server.js"], env: { API_KEY: "SECRET_VALUE" } },
    ]);
  });

  it("excludes disabled servers and lets project definitions override global definitions", async () => {
    const result = await resolveMcpServersForRuntime({
      globalSettings: {
        mcpServers: {
          enabled: true,
          servers: [
            { name: "override", transport: "stdio", command: "old" },
            { name: "removed", transport: "stdio", command: "remove-me" },
          ],
        },
      },
      projectSettings: {
        mcpServers: {
          enabled: true,
          servers: [
            { name: "override", transport: "sse", url: "https://mcp.example/sse", headers: { Authorization: { secretRef: "auth", scope: "project" } } },
            { name: "removed", enabled: false, transport: "stdio", command: "noop" },
          ],
        },
      },
      secrets: secrets({ auth: "Bearer SECRET" }),
    });

    expect(result.errors).toEqual([]);
    expect(result.servers).toEqual([
      { name: "override", transport: "sse", url: "https://mcp.example/sse", headers: { Authorization: "Bearer SECRET" } },
    ]);
  });

  it("resolves through the TaskStore-compatible settings split seam", async () => {
    const { resolveMcpServersForStore } = await import("../mcp-resolution.js");
    const result = await resolveMcpServersForStore({
      async getSettingsByScope() {
        return {
          global: { mcpServers: { enabled: true, servers: [{ name: "store", transport: "stdio", command: "node" }] } },
          project: { mcpServers: { enabled: true, servers: [] } },
        };
      },
      async getSecretsStore() {
        return secrets({});
      },
    });

    expect(result).toEqual({
      servers: [{ name: "store", transport: "stdio", command: "node" }],
      errors: [],
      scopeByServerName: { store: "global" },
    });
  });

  it("treats a missing settings seam as a genuine empty configuration", async () => {
    const { resolveMcpServersForStore } = await import("../mcp-resolution.js");
    await expect(resolveMcpServersForStore({})).resolves.toEqual({ servers: [], errors: [] });
  });

  it("honors an explicitly disabled project scope and disabled project shadow", async () => {
    const disabledScope = await resolveMcpServersForRuntime({
      globalSettings: { mcpServers: { enabled: true, servers: [{ name: "global", transport: "stdio", command: "node" }] } },
      projectSettings: { mcpServers: { enabled: false, servers: [] } },
      secrets: secrets({}),
    });
    const disabledShadow = await resolveMcpServersForRuntime({
      globalSettings: { mcpServers: { enabled: true, servers: [{ name: "global", transport: "stdio", command: "node" }] } },
      projectSettings: { mcpServers: { enabled: true, servers: [{ name: "global", enabled: false, transport: "stdio", command: "noop" }] } },
      secrets: secrets({}),
    });

    expect(disabledScope).toEqual({ servers: [], errors: [] });
    expect(disabledShadow).toEqual({ servers: [], errors: [] });
  });

  it("returns materialization errors without leaking through logs", async () => {
    const result = await resolveMcpServersForRuntime({
      globalSettings: {
        mcpServers: {
          enabled: true,
          servers: [
            { name: "broken", transport: "streamable-http", url: "https://mcp.example", headers: { Authorization: { secretRef: "missing", scope: "project" } } },
          ],
        },
      },
      projectSettings: null,
      secrets: secrets({}),
    });

    expect(result.servers).toEqual([{ name: "broken", transport: "streamable-http", url: "https://mcp.example" }]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.serverName).toBe("broken");
  });

  /*
   * FNXC:McpConfig 2026-07-12-00:00:
   * FUSI-074 Step 4 (resolution/runtime path): resolveMcpServersForRuntime already threads FUSI-073's oauth `auth`
   * block through materialization unchanged (secret-bearing fields resolved to plain strings). This test proves
   * the resolved oauth material reaches the shared HTTP-family transport helper end-to-end — the same helper
   * used by every MCP consumer path — rather than only asserting the intermediate resolved-server shape.
   */
  it("resolves oauth secret refs and the runtime transport-construction seam attaches an authProvider for both HTTP transports", async () => {
    const oauthSecrets = secrets({
      "oauth-client-secret": "cs-value",
      "oauth-access-token": "access-value",
      "oauth-refresh-token": "refresh-value",
    });

    for (const transport of ["sse", "streamable-http"] as const) {
      const result = await resolveMcpServersForRuntime({
        globalSettings: {
          mcpServers: {
            enabled: true,
            servers: [
              {
                name: `oauth-${transport}`,
                transport,
                url: "https://mcp.example/oauth",
                auth: {
                  type: "oauth",
                  authorizationServerUrl: "https://auth.example.test",
                  clientId: "client-1",
                  clientSecret: { secretRef: "oauth-client-secret", scope: "global" },
                  accessToken: { secretRef: "oauth-access-token", scope: "global" },
                  refreshToken: { secretRef: "oauth-refresh-token", scope: "global" },
                  expiresAt: Date.now() + 60_000,
                },
              },
            ],
          },
        },
        projectSettings: null,
        secrets: oauthSecrets,
      });

      expect(result.errors).toEqual([]);
      const resolved = result.servers[0] as Extract<typeof result.servers[number], { transport: "sse" | "streamable-http" }>;
      expect(resolved.auth).toMatchObject({ accessToken: "access-value", refreshToken: "refresh-value", clientSecret: "cs-value" });

      const httpTransport = createHttpMcpTransport(resolved) as unknown as { _authProvider?: unknown };
      expect(httpTransport._authProvider).toBeInstanceOf(FusionMcpOAuthProvider);
    }
  });

  /*
   * FNXC:McpConfig 2026-07-12-00:00:
   * FUSI-076: `resolveEffectiveMcpServers`'s project-over-global merge collapses which scope a server came from,
   * so `scopeByServerName` is computed alongside `servers`/`errors` as the addressing map writeback needs.
   */
  it("scopeByServerName tags each surviving server with its owning scope (project-over-global, disabled removal)", async () => {
    const result = await resolveMcpServersForRuntime({
      globalSettings: {
        mcpServers: {
          enabled: true,
          servers: [
            { name: "shared", transport: "stdio", command: "global-cmd" },
            { name: "global-only", transport: "stdio", command: "global-cmd" },
            { name: "removed", transport: "stdio", command: "global-cmd" },
          ],
        },
      },
      projectSettings: {
        mcpServers: {
          enabled: true,
          servers: [
            { name: "shared", transport: "stdio", command: "project-cmd" },
            { name: "project-only", transport: "stdio", command: "project-cmd" },
            { name: "removed", transport: "stdio", command: "project-cmd", enabled: false },
          ],
        },
      },
      secrets: secrets({}),
    });

    expect(result.scopeByServerName).toEqual({
      shared: "project",
      "global-only": "global",
      "project-only": "project",
    });
  });
});

describe("buildMcpOAuthTokenStore", () => {
  function fullStore() {
    const updateCalls: unknown[] = [];
    return {
      updateCalls,
      async getSettingsByScope() {
        return {
          global: { mcpServers: { enabled: true, servers: [] } },
          project: {
            mcpServers: {
              enabled: true,
              servers: [
                {
                  name: "asana",
                  transport: "sse" as const,
                  url: "https://mcp.example/asana",
                  auth: { type: "oauth" as const, authorizationServerUrl: "https://auth.example.test" },
                },
              ],
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

  it("builds the real (non-warn-only) token store when the settings+secrets store fully supports persistence", async () => {
    const store = fullStore();
    const oauthTokenStore = await buildMcpOAuthTokenStore(store);
    expect(oauthTokenStore).toBeDefined();

    await oauthTokenStore!.saveTokens("asana", { accessToken: "at-1" }, { scope: "project" });
    expect(store.updateCalls).toHaveLength(1);
  });

  it("returns undefined (caller falls back to warn-only) when settings writers are missing", async () => {
    const oauthTokenStore = await buildMcpOAuthTokenStore({
      async getSettingsByScope() {
        return { global: { mcpServers: { enabled: true, servers: [] } }, project: {} };
      },
      async getSecretsStore() {
        return { async revealSecret() { throw new Error("unused"); } };
      },
    });
    expect(oauthTokenStore).toBeUndefined();
  });

  it("returns undefined when the secrets reader lacks the create/update/list persistence surface", async () => {
    const store = fullStore();
    (store as { getSecretsStore: () => Promise<unknown> }).getSecretsStore = async () => ({
      async revealSecret() {
        throw new Error("unused");
      },
    });
    const oauthTokenStore = await buildMcpOAuthTokenStore(store);
    expect(oauthTokenStore).toBeUndefined();
  });

  it("resolveMcpServersForStore's no-store fallback still yields undefined store material (warn-only remains the caller's fallback)", async () => {
    const result = await resolveMcpServersForStore({});
    expect(result).toEqual({ servers: [], errors: [], scopeByServerName: {} });
    // Callers falling back to warn-only when no store is buildable is exercised at the consumer-path level
    // (mcp-session-tools.test.ts / mcp-validation-service.test.ts); this just proves the empty-store contract
    // this function relies on is unchanged (additive, no drift).
    expect(createWarnOnlyMcpOAuthTokenStore()).toBeDefined();
  });
});
