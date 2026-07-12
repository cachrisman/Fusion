import { describe, expect, it, vi } from "vitest";
import type { ResolvedMcpServerDefinition } from "@fusion/core";
import {
  completeMcpOAuthCallback,
  createInMemoryMcpOAuthAuthorizeStore,
  McpOAuthNotConfiguredError,
  McpOAuthStateRequiredError,
  McpOAuthVerifierMissingError,
  startMcpOAuthAuthorize,
} from "./mcp-oauth-authorize.js";

/*
 * FNXC:McpConfig 2026-07-12-00:00:
 * These tests drive the real SDK `auth()` orchestrator against a stubbed fetch (no network), asserting the
 * invariant end-to-end: DCR path (no pre-issued clientId) and pre-registered-client path both reach a valid
 * PKCE authorization URL, callback completion persists the token bundle via the injected store, and CSRF/replay
 * guards reject cleanly. No test asserts against real network I/O.
 */

const AUTH_SERVER = "https://auth.example.test";
const MCP_URL = "https://mcp.example.test/sse";

function oauthServer(overrides: Partial<Extract<ResolvedMcpServerDefinition, { transport: "sse" }>["auth"]> = {}): Extract<
  ResolvedMcpServerDefinition,
  { transport: "sse" }
> {
  return {
    name: "srv",
    transport: "sse",
    url: MCP_URL,
    auth: {
      type: "oauth",
      authorizationServerUrl: AUTH_SERVER,
      ...overrides,
    },
  };
}

function stdioServer(): ResolvedMcpServerDefinition {
  return { name: "stdio-srv", transport: "stdio", command: "node" };
}

/** Minimal fetch stub covering RFC 9728/8414 discovery (404s = "not supported"), RFC 7591 DCR, and token exchange. */
function makeFetchStub(opts: { dcrClientId?: string } = {}) {
  return vi.fn(async (input: unknown, _init?: unknown) => {
    const url = String(input);
    if (url.includes("/.well-known/oauth-protected-resource")) {
      return new Response(null, { status: 404 });
    }
    if (url.includes("/.well-known/oauth-authorization-server")) {
      return new Response(
        JSON.stringify({
          issuer: AUTH_SERVER,
          authorization_endpoint: `${AUTH_SERVER}/authorize`,
          token_endpoint: `${AUTH_SERVER}/token`,
          registration_endpoint: `${AUTH_SERVER}/register`,
          response_types_supported: ["code"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/register")) {
      // RFC 7591 DCR responses echo back the client metadata (redirect_uris etc.) alongside the
      // issued client_id/client_secret — OAuthClientInformationFullSchema requires redirect_uris.
      return new Response(
        JSON.stringify({
          client_id: opts.dcrClientId ?? "dcr-client-id",
          client_secret: "dcr-client-secret",
          redirect_uris: ["https://dash.test/cb"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/token")) {
      return new Response(
        JSON.stringify({ access_token: "issued-access-token", token_type: "Bearer", expires_in: 3600, refresh_token: "issued-refresh-token" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe("startMcpOAuthAuthorize", () => {
  it("rejects a non-oauth server definition", async () => {
    const store = createInMemoryMcpOAuthAuthorizeStore();
    await expect(
      startMcpOAuthAuthorize(stdioServer(), { store, redirectUri: "https://dash.test/cb", state: "s1" }),
    ).rejects.toThrow(McpOAuthNotConfiguredError);
  });

  it("rejects a missing/empty state", async () => {
    const store = createInMemoryMcpOAuthAuthorizeStore();
    await expect(
      startMcpOAuthAuthorize(oauthServer({ clientId: "pre-registered" }), { store, redirectUri: "https://dash.test/cb", state: "" }),
    ).rejects.toThrow(McpOAuthStateRequiredError);
  });

  it("DCR path: no pre-issued clientId — performs RFC 7591 DCR and builds a valid authorization URL", async () => {
    const fetchFn = makeFetchStub();
    const store = createInMemoryMcpOAuthAuthorizeStore();
    const result = await startMcpOAuthAuthorize(oauthServer(), {
      store,
      redirectUri: "https://dash.test/cb",
      state: "csrf-state-1",
      fetchFn: fetchFn as never,
    });

    expect(result.authorizationUrl).toMatch(/^https:\/\/auth\.example\.test\/authorize\?/);
    const parsed = new URL(result.authorizationUrl);
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("state")).toBe("csrf-state-1");
    expect(parsed.searchParams.get("client_id")).toBe("dcr-client-id");
    expect(store.savedClientInfo.get("srv")).toMatchObject({ client_id: "dcr-client-id" });
  });

  it("pre-registered path: existing clientId skips DCR and still builds a valid authorization URL", async () => {
    const fetchFn = makeFetchStub();
    const store = createInMemoryMcpOAuthAuthorizeStore();
    const result = await startMcpOAuthAuthorize(oauthServer({ clientId: "pre-registered-client" }), {
      store,
      redirectUri: "https://dash.test/cb",
      state: "csrf-state-2",
      fetchFn: fetchFn as never,
    });

    expect(result.authorizationUrl).toMatch(/^https:\/\/auth\.example\.test\/authorize\?/);
    const parsed = new URL(result.authorizationUrl);
    expect(parsed.searchParams.get("client_id")).toBe("pre-registered-client");
    expect(fetchFn.mock.calls.some((call) => String(call[0]).includes("/register"))).toBe(false);
    expect(store.savedClientInfo.has("srv")).toBe(false);
  });

  it("persists the PKCE code verifier for later consumption", async () => {
    const fetchFn = makeFetchStub();
    const store = createInMemoryMcpOAuthAuthorizeStore();
    await startMcpOAuthAuthorize(oauthServer({ clientId: "pre-registered-client" }), {
      store,
      redirectUri: "https://dash.test/cb",
      state: "csrf-state-3",
      fetchFn: fetchFn as never,
    });
    const verifier = await store.consumeCodeVerifier("srv");
    expect(verifier).toBeTruthy();
  });

  it("never surfaces token/url material in a thrown error's message for a rejected server", async () => {
    const store = createInMemoryMcpOAuthAuthorizeStore();
    try {
      await startMcpOAuthAuthorize(stdioServer(), { store, redirectUri: "https://dash.test/cb", state: "s1" });
      throw new Error("expected rejection");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("stdio-srv");
      expect(message).not.toContain("access-token");
    }
  });
});

describe("completeMcpOAuthCallback", () => {
  async function startedFlow(clientId?: string) {
    const fetchFn = makeFetchStub();
    const store = createInMemoryMcpOAuthAuthorizeStore();
    await startMcpOAuthAuthorize(oauthServer({ clientId }), {
      store,
      redirectUri: "https://dash.test/cb",
      state: "csrf-state",
      fetchFn: fetchFn as never,
    });
    return { store, fetchFn };
  }

  it("rejects a non-oauth server definition", async () => {
    const store = createInMemoryMcpOAuthAuthorizeStore();
    await expect(
      completeMcpOAuthCallback(stdioServer(), { store, code: "abc", state: "s1", redirectUri: "https://dash.test/cb" }),
    ).rejects.toThrow(McpOAuthNotConfiguredError);
  });

  it("rejects a missing/empty state", async () => {
    const { store, fetchFn } = await startedFlow("pre-registered-client");
    await expect(
      completeMcpOAuthCallback(oauthServer({ clientId: "pre-registered-client" }), {
        store,
        code: "auth-code",
        state: "",
        redirectUri: "https://dash.test/cb",
        fetchFn: fetchFn as never,
      }),
    ).rejects.toThrow(McpOAuthStateRequiredError);
  });

  it("exchanges the code and persists the token bundle (DCR-issued client)", async () => {
    const { store, fetchFn } = await startedFlow();
    const result = await completeMcpOAuthCallback(oauthServer(), {
      store,
      code: "auth-code",
      state: "csrf-state",
      redirectUri: "https://dash.test/cb",
      fetchFn: fetchFn as never,
    });
    expect(result).toEqual({ ok: true });
    expect(store.savedTokens.get("srv")).toMatchObject({ accessToken: "issued-access-token", refreshToken: "issued-refresh-token" });
  });

  it("exchanges the code and persists the token bundle (pre-registered client)", async () => {
    const { store, fetchFn } = await startedFlow("pre-registered-client");
    const result = await completeMcpOAuthCallback(oauthServer({ clientId: "pre-registered-client" }), {
      store,
      code: "auth-code",
      state: "csrf-state",
      redirectUri: "https://dash.test/cb",
      fetchFn: fetchFn as never,
    });
    expect(result).toEqual({ ok: true });
    expect(store.savedTokens.get("srv")).toMatchObject({ accessToken: "issued-access-token" });
  });

  it("rejects a replayed callback — the verifier was already consumed by the first exchange", async () => {
    const { store, fetchFn } = await startedFlow("pre-registered-client");
    await completeMcpOAuthCallback(oauthServer({ clientId: "pre-registered-client" }), {
      store,
      code: "auth-code",
      state: "csrf-state",
      redirectUri: "https://dash.test/cb",
      fetchFn: fetchFn as never,
    });
    await expect(
      completeMcpOAuthCallback(oauthServer({ clientId: "pre-registered-client" }), {
        store,
        code: "auth-code-2",
        state: "csrf-state",
        redirectUri: "https://dash.test/cb",
        fetchFn: fetchFn as never,
      }),
    ).rejects.toThrow(McpOAuthVerifierMissingError);
  });

  it("never surfaces token/code/url material in logs (fetch stub call args only, never asserted-as-logged)", async () => {
    const { store, fetchFn } = await startedFlow("pre-registered-client");
    const logger = { warn: vi.fn() };
    await completeMcpOAuthCallback(oauthServer({ clientId: "pre-registered-client" }), {
      store,
      code: "auth-code",
      state: "csrf-state",
      redirectUri: "https://dash.test/cb",
      fetchFn: fetchFn as never,
      logger,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
