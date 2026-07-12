import { describe, expect, it, vi } from "vitest";
import type { ResolvedMcpOAuthAuth, ResolvedMcpServerDefinition } from "@fusion/core";
import { validateMcpServer } from "../mcp-validation-service.js";

const refreshAuthorizationMock = vi.fn();
vi.mock("@modelcontextprotocol/sdk/client/auth.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, refreshAuthorization: (...args: unknown[]) => refreshAuthorizationMock(...args) };
});

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

describe("mcp-validation-service", () => {
  it("uses an injected stdio probe for stdio servers", async () => {
    const server: ResolvedMcpServerDefinition = {
      name: "local",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      env: { TOKEN: "secret-value" },
    };
    const stdioProbe = vi.fn(async () => ({ status: "valid" as const, message: "ok" }));

    await expect(validateMcpServer(server, { stdioProbe, timeoutMs: 25 })).resolves.toEqual({ status: "valid", message: "ok" });
    expect(stdioProbe).toHaveBeenCalledWith(server, { timeoutMs: 25, cwd: undefined });
  });

  it("treats reachable SSE responses below 500 as valid", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 }));
    const server: ResolvedMcpServerDefinition = {
      name: "events",
      transport: "sse",
      url: "https://example.test/sse",
      headers: { Authorization: "Bearer secret-value" },
    };

    const result = await validateMcpServer(server, { fetchImpl, timeoutMs: 25 });

    expect(result).toEqual({ status: "valid", message: "server responded with HTTP 401" });
    expect(fetchImpl).toHaveBeenCalledWith("https://example.test/sse", expect.objectContaining({
      method: "GET",
      headers: { Authorization: "Bearer secret-value" },
    }));
  });

  it("returns error for streamable HTTP 5xx responses", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }));
    const server: ResolvedMcpServerDefinition = {
      name: "http",
      transport: "streamable-http",
      url: "https://example.test/mcp",
    };

    await expect(validateMcpServer(server, { fetchImpl, timeoutMs: 25 })).resolves.toEqual({
      status: "error",
      message: "server responded with HTTP 503",
    });
  });

  it("returns unreachable for fetch failures without echoing headers", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const server: ResolvedMcpServerDefinition = {
      name: "http",
      transport: "streamable-http",
      url: "https://example.test/mcp",
      headers: { Authorization: "super-secret" },
    };

    const result = await validateMcpServer(server, { fetchImpl, timeoutMs: 25 });

    expect(result.status).toBe("unreachable");
    expect(result.message).toBe("ECONNREFUSED");
    expect(JSON.stringify(result)).not.toContain("super-secret");
  });

  describe("oauth wiring", () => {
    it("probes with a bearer token from the authProvider for sse servers with a valid oauth token", async () => {
      const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
      const server: Extract<ResolvedMcpServerDefinition, { transport: "sse" }> = {
        name: "sse-oauth",
        transport: "sse",
        url: "https://example.test/sse",
        auth: oauthAuth(),
      };

      const result = await validateMcpServer(server, { fetchImpl, timeoutMs: 25 });

      expect(result).toEqual({ status: "valid", message: "server responded with HTTP 200" });
      expect(fetchImpl).toHaveBeenCalledWith(
        "https://example.test/sse",
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer access-token-value" }) }),
      );
    });

    it("probes with a bearer token from the authProvider for streamable-http servers with a valid oauth token", async () => {
      const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
      const server: Extract<ResolvedMcpServerDefinition, { transport: "streamable-http" }> = {
        name: "http-oauth",
        transport: "streamable-http",
        url: "https://example.test/mcp",
        auth: oauthAuth(),
      };

      const result = await validateMcpServer(server, { fetchImpl, timeoutMs: 25 });

      expect(result).toEqual({ status: "valid", message: "server responded with HTTP 200" });
      expect(fetchImpl).toHaveBeenCalledWith(
        "https://example.test/mcp",
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer access-token-value" }) }),
      );
    });

    it("performs a non-interactive refresh at probe creation when the stored token is expired", async () => {
      refreshAuthorizationMock.mockReset().mockResolvedValueOnce({
        access_token: "refreshed-token",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "new-refresh",
      });
      const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
      const server: Extract<ResolvedMcpServerDefinition, { transport: "streamable-http" }> = {
        name: "http-oauth",
        transport: "streamable-http",
        url: "https://example.test/mcp",
        auth: oauthAuth({ expiresAt: Date.now() - 60_000 }),
      };

      const result = await validateMcpServer(server, { fetchImpl, timeoutMs: 25 });

      expect(refreshAuthorizationMock).toHaveBeenCalledTimes(1);
      expect(result.status).toBe("valid");
      expect(fetchImpl).toHaveBeenCalledWith(
        "https://example.test/mcp",
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer refreshed-token" }) }),
      );
    });

    it("returns an actionable error status (no crash, no browser) when there is no stored token", async () => {
      const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
      const server: Extract<ResolvedMcpServerDefinition, { transport: "sse" }> = {
        name: "no-token",
        transport: "sse",
        url: "https://example.test/sse",
        auth: oauthAuth({ accessToken: undefined, refreshToken: undefined }),
      };

      const result = await validateMcpServer(server, { fetchImpl, timeoutMs: 25 });

      expect(result).toEqual({ status: "error", message: "oauth: needs re-authorize (no stored token)" });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("returns an actionable error status (no crash) when the non-interactive refresh fails", async () => {
      refreshAuthorizationMock.mockReset().mockRejectedValueOnce(new Error("invalid_grant"));
      const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
      const server: Extract<ResolvedMcpServerDefinition, { transport: "streamable-http" }> = {
        name: "refresh-failed",
        transport: "streamable-http",
        url: "https://example.test/mcp",
        auth: oauthAuth({ expiresAt: Date.now() - 60_000 }),
      };

      const result = await validateMcpServer(server, { fetchImpl, timeoutMs: 25 });

      expect(result).toEqual({ status: "error", message: "oauth: needs re-authorize (refresh failed)" });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
});

describe("validateMcpServer — real token store wiring (FUSI-076 Step 3)", () => {
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
              servers: [{ name: "probe-oauth", transport: "sse" as const, url: "https://example.test/sse", auth: serverAuth }],
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

  it("persists a refreshed token via the concrete store when mcpSettingsStore + scope are supplied", async () => {
    refreshAuthorizationMock.mockReset().mockResolvedValueOnce({
      access_token: "refreshed-token",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "refreshed-refresh",
    });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const server: Extract<ResolvedMcpServerDefinition, { transport: "sse" }> = {
      name: "probe-oauth",
      transport: "sse",
      url: "https://example.test/sse",
      auth: oauthAuth({ expiresAt: Date.now() - 60_000 }),
    };
    const mcpSettingsStore = fullMcpSettingsStore(server.auth);

    const result = await validateMcpServer(server, { fetchImpl, timeoutMs: 25, mcpSettingsStore, scope: "project" });

    expect(result.status).toBe("valid");
    expect(mcpSettingsStore.updateCalls).toHaveLength(1);
  });

  it("falls back to warn-only (no persistence call) when no mcpSettingsStore/oauthTokenStore is supplied", async () => {
    refreshAuthorizationMock.mockReset().mockResolvedValueOnce({
      access_token: "refreshed-token",
      token_type: "Bearer",
      expires_in: 3600,
    });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const server: Extract<ResolvedMcpServerDefinition, { transport: "sse" }> = {
      name: "probe-oauth",
      transport: "sse",
      url: "https://example.test/sse",
      auth: oauthAuth({ expiresAt: Date.now() - 60_000 }),
    };

    const result = await validateMcpServer(server, { fetchImpl, timeoutMs: 25 });
    expect(result.status).toBe("valid");
  });
});
