import { describe, expect, it, vi } from "vitest";
import type { ResolvedMcpOAuthAuth, ResolvedMcpServerDefinition } from "@fusion/core";
import {
  FusionMcpOAuthProvider,
  McpOAuthInteractiveRequiredError,
  McpOAuthNoTokenError,
  McpOAuthRefreshFailedError,
  createFusionMcpOAuthProvider,
  createHttpMcpTransport,
  createWarnOnlyMcpOAuthTokenStore,
  describeMcpOAuthError,
  hasMcpOAuthAuth,
  type McpOAuthTokenStore,
} from "../mcp-oauth-provider.js";

const refreshAuthorizationMock = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/auth.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, refreshAuthorization: (...args: unknown[]) => refreshAuthorizationMock(...args) };
});

const FUTURE = Date.now() + 60_000;
const PAST = Date.now() - 60_000;

function baseAuth(overrides: Partial<ResolvedMcpOAuthAuth> = {}): ResolvedMcpOAuthAuth {
  return {
    type: "oauth",
    authorizationServerUrl: "https://auth.example.test",
    clientId: "client-123",
    clientSecret: "client-secret-value",
    accessToken: "access-token-value",
    refreshToken: "refresh-token-value",
    expiresAt: FUTURE,
    scopes: ["read", "write"],
    redirectUrl: "https://dashboard.example.test/callback",
    ...overrides,
  };
}

function fakeStore(): McpOAuthTokenStore & { saved: Array<{ serverName: string; tokens: unknown }> } {
  const saved: Array<{ serverName: string; tokens: unknown }> = [];
  return {
    saved,
    async saveTokens(serverName, tokens) {
      saved.push({ serverName, tokens });
    },
    async saveClientInformation() {
      /* no-op for tests */
    },
  };
}

describe("FusionMcpOAuthProvider", () => {
  it("implements the OAuthClientProvider interface surface", () => {
    const provider = createFusionMcpOAuthProvider("srv", baseAuth());
    expect(provider.redirectUrl).toBe("https://dashboard.example.test/callback");
    expect(provider.clientMetadata).toMatchObject({ redirect_uris: ["https://dashboard.example.test/callback"] });
    expect(provider.clientInformation()).toMatchObject({ client_id: "client-123" });
  });

  it("returns the current bundle from tokens() when the access token is unexpired", async () => {
    const provider = createFusionMcpOAuthProvider("srv", baseAuth({ expiresAt: FUTURE }));
    const tokens = await provider.tokens();
    expect(tokens).toMatchObject({ access_token: "access-token-value", token_type: "Bearer" });
    expect(refreshAuthorizationMock).not.toHaveBeenCalled();
  });

  it("throws no-token when there is no access token and no refresh token", async () => {
    const provider = createFusionMcpOAuthProvider("srv", baseAuth({ accessToken: undefined, refreshToken: undefined }));
    await expect(provider.tokens()).rejects.toThrow(McpOAuthNoTokenError);
  });

  it("throws no-token (needs re-authorize) when expired and there is no refresh token", async () => {
    const provider = createFusionMcpOAuthProvider("srv", baseAuth({ expiresAt: PAST, refreshToken: undefined }));
    await expect(provider.tokens()).rejects.toThrow(McpOAuthNoTokenError);
  });

  it("performs a non-interactive refresh when expired with a refresh token, and persists the refreshed bundle", async () => {
    refreshAuthorizationMock.mockReset().mockResolvedValueOnce({
      access_token: "new-access-token",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "new-refresh-token",
    });
    const store = fakeStore();
    const provider = createFusionMcpOAuthProvider("srv", baseAuth({ expiresAt: PAST }), { tokenStore: store });

    const tokens = await provider.tokens();

    expect(refreshAuthorizationMock).toHaveBeenCalledTimes(1);
    expect(refreshAuthorizationMock).toHaveBeenCalledWith(
      "https://auth.example.test",
      expect.objectContaining({ refreshToken: "refresh-token-value", clientInformation: expect.objectContaining({ client_id: "client-123" }) }),
    );
    expect(tokens).toMatchObject({ access_token: "new-access-token", refresh_token: "new-refresh-token" });
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]).toMatchObject({ serverName: "srv", tokens: { accessToken: "new-access-token", refreshToken: "new-refresh-token" } });
  });

  it("wraps a refresh failure as McpOAuthRefreshFailedError (fail-soft, no crash) and persists nothing", async () => {
    refreshAuthorizationMock.mockReset().mockRejectedValueOnce(new Error("invalid_grant"));
    const store = fakeStore();
    const provider = createFusionMcpOAuthProvider("srv", baseAuth({ expiresAt: PAST }), { tokenStore: store });

    await expect(provider.tokens()).rejects.toThrow(McpOAuthRefreshFailedError);
    expect(store.saved).toEqual([]);
  });

  it("throws refresh-failed (not a raw error) when no clientId is configured to authenticate the refresh", async () => {
    refreshAuthorizationMock.mockReset();
    const store = fakeStore();
    const provider = createFusionMcpOAuthProvider("srv", baseAuth({ expiresAt: PAST, clientId: undefined }), { tokenStore: store });
    await expect(provider.tokens()).rejects.toThrow(McpOAuthRefreshFailedError);
    expect(refreshAuthorizationMock).not.toHaveBeenCalled();
    expect(store.saved).toEqual([]);
  });

  it("saveTokens maps the SDK bundle back to Fusion's absolute expiresAt and persists via the store", async () => {
    const store = fakeStore();
    const provider = createFusionMcpOAuthProvider("srv", baseAuth(), { tokenStore: store });
    const before = Date.now();
    await provider.saveTokens({ access_token: "tok", token_type: "Bearer", expires_in: 100, refresh_token: "rtok" });
    expect(store.saved).toHaveLength(1);
    const saved = store.saved[0]!.tokens as { accessToken: string; refreshToken: string; expiresAt: number };
    expect(saved.accessToken).toBe("tok");
    expect(saved.refreshToken).toBe("rtok");
    expect(saved.expiresAt).toBeGreaterThanOrEqual(before + 100 * 1000 - 5);
  });

  it("never logs or exposes token/secret material in error messages", async () => {
    const provider = createFusionMcpOAuthProvider("secret-server", baseAuth({ accessToken: undefined, refreshToken: undefined }));
    try {
      await provider.tokens();
      throw new Error("expected rejection");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("access-token-value");
      expect(message).not.toContain("refresh-token-value");
      expect(message).not.toContain("client-secret-value");
      expect(message).toContain("secret-server");
    }
  });

  it("redirectToAuthorization never opens a browser or spawns a process — it throws the typed marker", () => {
    const provider = createFusionMcpOAuthProvider("srv", baseAuth());
    let threw: unknown;
    try {
      provider.redirectToAuthorization(new URL("https://auth.example.test/authorize") as never);
    } catch (error) {
      threw = error;
    }
    expect(threw).toBeInstanceOf(McpOAuthInteractiveRequiredError);
  });

  it("saveCodeVerifier/codeVerifier also refuse interactively (engine never runs the code exchange)", async () => {
    const provider = createFusionMcpOAuthProvider("srv", baseAuth());
    await expect(provider.saveCodeVerifier("verifier")).rejects.toThrow(McpOAuthInteractiveRequiredError);
    await expect(provider.codeVerifier()).rejects.toThrow(McpOAuthInteractiveRequiredError);
  });

  it("describeMcpOAuthError maps each typed error to an actionable, content-free reason", () => {
    expect(describeMcpOAuthError(new McpOAuthNoTokenError("srv"))).toBe("oauth: needs re-authorize (no stored token)");
    expect(describeMcpOAuthError(new McpOAuthRefreshFailedError("srv"))).toBe("oauth: needs re-authorize (refresh failed)");
    expect(describeMcpOAuthError(new McpOAuthInteractiveRequiredError("srv"))).toBe(
      "oauth: needs re-authorize (interactive authorize required)",
    );
    expect(describeMcpOAuthError(new Error("boom"))).toBeUndefined();
  });

  it("warn-only default token store logs only the server name, never token material", async () => {
    const warn = vi.fn();
    const store = createWarnOnlyMcpOAuthTokenStore({ warn });
    await store.saveTokens("srv", { accessToken: "top-secret" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).not.toContain("top-secret");
    expect(warn.mock.calls[0]![0]).toContain("srv");
  });
});

describe("createHttpMcpTransport", () => {
  it("attaches an authProvider for sse servers with a resolved oauth auth block", () => {
    const server: Extract<ResolvedMcpServerDefinition, { transport: "sse" }> = {
      name: "sse-oauth",
      transport: "sse",
      url: "https://mcp.example.test/sse",
      auth: baseAuth(),
    };
    const transport = createHttpMcpTransport(server) as unknown as { _authProvider?: unknown };
    expect(transport._authProvider).toBeInstanceOf(FusionMcpOAuthProvider);
  });

  it("attaches an authProvider for streamable-http servers with a resolved oauth auth block", () => {
    const server: Extract<ResolvedMcpServerDefinition, { transport: "streamable-http" }> = {
      name: "http-oauth",
      transport: "streamable-http",
      url: "https://mcp.example.test/mcp",
      auth: baseAuth(),
    };
    const transport = createHttpMcpTransport(server) as unknown as { _authProvider?: unknown };
    expect(transport._authProvider).toBeInstanceOf(FusionMcpOAuthProvider);
  });

  it("leaves headers-only (no-auth) servers unchanged — no authProvider attached", () => {
    const server: Extract<ResolvedMcpServerDefinition, { transport: "streamable-http" }> = {
      name: "http-plain",
      transport: "streamable-http",
      url: "https://mcp.example.test/mcp",
      headers: { Authorization: "Bearer static-token" },
    };
    const transport = createHttpMcpTransport(server) as unknown as { _authProvider?: unknown };
    expect(transport._authProvider).toBeUndefined();
  });

  it("hasMcpOAuthAuth identifies HTTP-family servers with a resolved oauth block only", () => {
    const oauthServer: ResolvedMcpServerDefinition = {
      name: "a",
      transport: "sse",
      url: "https://example.test",
      auth: baseAuth(),
    };
    const plainServer: ResolvedMcpServerDefinition = { name: "b", transport: "sse", url: "https://example.test" };
    const stdioServer: ResolvedMcpServerDefinition = { name: "c", transport: "stdio", command: "node" };
    expect(hasMcpOAuthAuth(oauthServer)).toBe(true);
    expect(hasMcpOAuthAuth(plainServer)).toBe(false);
    expect(hasMcpOAuthAuth(stdioServer)).toBe(false);
  });
});
