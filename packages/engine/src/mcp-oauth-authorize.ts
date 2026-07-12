import { auth as sdkAuthorize, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ResolvedMcpOAuthAuth, ResolvedMcpServerDefinition } from "@fusion/core";
import {
  FusionMcpOAuthProvider,
  hasMcpOAuthAuth,
  type McpOAuthTokenBundle,
  type McpOAuthTokenStore,
} from "./mcp-oauth-provider.js";

/*
 * FNXC:McpConfig 2026-07-12-00:00:
 * Phase 3 (this module) is the ONLY place in `@fusion/engine` that performs interactive MCP OAuth authorize
 * (dashboard-hosted, one-time). It exists because the headless `FusionMcpOAuthProvider` (Phase 2,
 * mcp-oauth-provider.ts) intentionally throws on `redirectToAuthorization()`/`saveCodeVerifier()`/
 * `codeVerifier()` — the engine must never open a browser. Rather than reimplementing PKCE / RFC 8414
 * authorization-server metadata discovery / RFC 7591 DCR by hand, this module drives the SDK's own `auth()`
 * orchestrator (`@modelcontextprotocol/sdk/client/auth.js`) and composes (not forks) `FusionMcpOAuthProvider`
 * for the token-bundle plumbing (tokens()/saveTokens()/clientMetadata/redirectUrl), adding only the interactive
 * bits: `state()` (CSRF value supplied by the dashboard route, which owns the authoritative state<->server
 * mapping check), `redirectToAuthorization()` (captures the authorization URL instead of navigating — Node has
 * no browser), and `saveCodeVerifier()`/`codeVerifier()` (persisted/consumed through the injected
 * `McpOAuthAuthorizeStore` seam so a replayed callback finds no verifier and fails cleanly). The dashboard must
 * not construct a second, divergent `OAuthClientProvider` — it only ever calls these two exported functions.
 * Never logs or returns code/token/url material; callers must keep logging to server name / transport / coarse
 * status only.
 */

/** Thrown when the server definition is not oauth-configured (headers-only or stdio). */
export class McpOAuthNotConfiguredError extends Error {
  readonly name = "McpOAuthNotConfiguredError";
  constructor(serverName: string) {
    super(`MCP server "${serverName}" is not configured for OAuth (missing/incompatible auth block)`);
  }
}

/** Thrown when the PKCE code verifier is missing or was already consumed (replay protection). */
export class McpOAuthVerifierMissingError extends Error {
  readonly name = "McpOAuthVerifierMissingError";
  constructor(serverName: string) {
    super(`MCP server "${serverName}" OAuth callback has no pending PKCE code verifier (missing or already consumed)`);
  }
}

/** Thrown when a required CSRF `state` value is missing/empty at the engine helper boundary. */
export class McpOAuthStateRequiredError extends Error {
  readonly name = "McpOAuthStateRequiredError";
  constructor(serverName: string) {
    super(`MCP server "${serverName}" OAuth authorize requires a non-empty state value`);
  }
}

/** Thrown when the SDK `auth()` orchestrator returns an unexpected result for the given phase. */
export class McpOAuthUnexpectedResultError extends Error {
  readonly name = "McpOAuthUnexpectedResultError";
  constructor(serverName: string, phase: "authorize" | "callback", result: string) {
    super(`MCP server "${serverName}" OAuth ${phase} produced an unexpected result: ${result}`);
  }
}

/**
 * Interactive persistence seam. Extends the headless `McpOAuthTokenStore` (token/client-info writeback) with
 * the two additions the interactive flow needs: reading back previously-persisted client information (so a
 * retried authorize reuses prior DCR registration instead of re-registering), and the PKCE code-verifier
 * round trip (save at authorize-start, consume-once at callback — a second consume must return `undefined` so
 * replayed callbacks are rejected).
 */
export interface McpOAuthAuthorizeStore extends McpOAuthTokenStore {
  /** Loads previously-persisted client information (pre-registered OR DCR-issued), if any. */
  loadClientInformation?(serverName: string): Promise<OAuthClientInformationMixed | undefined>;
  /** Persists the PKCE code verifier for the in-flight authorize attempt. */
  saveCodeVerifier(serverName: string, verifier: string): Promise<void>;
  /** Reads AND deletes the PKCE code verifier; a second call for the same attempt must return `undefined`. */
  consumeCodeVerifier(serverName: string): Promise<string | undefined>;
}

/**
 * Composes `FusionMcpOAuthProvider` (token-bundle logic reused, not reimplemented) with the interactive-only
 * `OAuthClientProvider` surface. Never navigates a browser — `redirectToAuthorization()` only captures the URL
 * for the caller to hand to the user's actual browser (an HTTP redirect / popup on the dashboard side).
 */
class InteractiveMcpOAuthProvider implements OAuthClientProvider {
  private readonly base: FusionMcpOAuthProvider;
  private readonly authorizeStore: McpOAuthAuthorizeStore;
  private readonly serverName: string;
  private readonly stateValue: string;
  lastAuthorizationUrl: URL | undefined;

  constructor(
    serverName: string,
    auth: ResolvedMcpOAuthAuth,
    opts: { store: McpOAuthAuthorizeStore; state: string; logger?: Pick<Console, "warn"> },
  ) {
    this.serverName = serverName;
    this.authorizeStore = opts.store;
    this.stateValue = opts.state;
    this.base = new FusionMcpOAuthProvider(serverName, auth, { tokenStore: opts.store, logger: opts.logger });
  }

  get redirectUrl(): string | URL | undefined {
    return this.base.redirectUrl;
  }

  get clientMetadata() {
    return this.base.clientMetadata;
  }

  state(): string {
    return this.stateValue;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const persisted = await this.authorizeStore.loadClientInformation?.(this.serverName);
    if (persisted) return persisted;
    return this.base.clientInformation();
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.base.saveClientInformation(clientInformation);
  }

  /**
   * The interactive start/callback flows never short-circuit on an existing token — authorize is an explicit
   * user action (re)establishing the grant, and the callback path always supplies `authorizationCode` (which
   * the SDK's `auth()` orchestrator checks before ever calling `tokens()`). Returning `undefined` unconditionally
   * keeps this provider simple and side-effect-free for the one thing it does not need to do: silent refresh
   * (that remains `FusionMcpOAuthProvider`'s job at runtime).
   */
  async tokens(): Promise<OAuthTokens | undefined> {
    return undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.base.saveTokens(tokens);
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.lastAuthorizationUrl = authorizationUrl;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.authorizeStore.saveCodeVerifier(this.serverName, codeVerifier);
  }

  async codeVerifier(): Promise<string> {
    const verifier = await this.authorizeStore.consumeCodeVerifier(this.serverName);
    if (!verifier) {
      throw new McpOAuthVerifierMissingError(this.serverName);
    }
    return verifier;
  }
}

type HttpMcpServer = Extract<ResolvedMcpServerDefinition, { transport: "sse" | "streamable-http" }>;

function requireOAuthServer(server: ResolvedMcpServerDefinition): asserts server is HttpMcpServer & { auth: ResolvedMcpOAuthAuth } {
  if (!hasMcpOAuthAuth(server)) {
    throw new McpOAuthNotConfiguredError(server.name);
  }
}

export interface StartMcpOAuthAuthorizeOptions {
  store: McpOAuthAuthorizeStore;
  /** Dashboard callback URL the authorization server will redirect back to. */
  redirectUri: string;
  /** CSRF state value — minted and authoritatively checked by the dashboard route, not this helper. */
  state: string;
  logger?: Pick<Console, "warn">;
  /** Test-injectable fetch override; production callers omit this and get the global fetch. */
  fetchFn?: FetchLike;
}

/**
 * Starts the interactive OAuth authorize flow for one server: RFC 8414 metadata discovery, RFC 7591 DCR when
 * no client is registered yet (pre-registered `clientId` skips DCR), and PKCE authorization-URL construction —
 * all via the SDK `auth()` orchestrator. The code verifier and any DCR-issued client info are persisted through
 * `opts.store` before this returns. Rejects non-oauth server definitions. Never logs/returns anything beyond the
 * authorization URL itself (which the caller redirects the user's browser to).
 */
export async function startMcpOAuthAuthorize(
  server: ResolvedMcpServerDefinition,
  opts: StartMcpOAuthAuthorizeOptions,
): Promise<{ authorizationUrl: string }> {
  requireOAuthServer(server);
  if (!opts.state || !opts.state.trim()) {
    throw new McpOAuthStateRequiredError(server.name);
  }

  const auth: ResolvedMcpOAuthAuth = { ...server.auth, redirectUrl: opts.redirectUri };
  const provider = new InteractiveMcpOAuthProvider(server.name, auth, { store: opts.store, state: opts.state, logger: opts.logger });

  const result = await sdkAuthorize(provider, { serverUrl: server.url, fetchFn: opts.fetchFn });
  if (result !== "REDIRECT" || !provider.lastAuthorizationUrl) {
    throw new McpOAuthUnexpectedResultError(server.name, "authorize", result);
  }
  return { authorizationUrl: provider.lastAuthorizationUrl.toString() };
}

export interface CompleteMcpOAuthCallbackOptions {
  store: McpOAuthAuthorizeStore;
  /** Authorization code returned by the authorization server on the callback redirect. */
  code: string;
  /** CSRF state value from the callback query string — the dashboard route must already have validated this
   * against its own state<->server mapping before calling this helper; passed through here only as a
   * non-empty-value guard, never re-derived or trusted as the sole check. */
  state: string;
  /** Must match the redirect URI used to start the flow. */
  redirectUri: string;
  logger?: Pick<Console, "warn">;
  /** Test-injectable fetch override; production callers omit this and get the global fetch. */
  fetchFn?: FetchLike;
}

/**
 * Completes the interactive OAuth authorize flow: exchanges the authorization code for tokens (PKCE code
 * verifier consumed exactly once from `opts.store`, so a replayed callback throws `McpOAuthVerifierMissingError`
 * instead of re-exchanging), and persists the resulting access/refresh/expiry bundle through `opts.store`.
 * Rejects non-oauth server definitions and missing `state`.
 */
export async function completeMcpOAuthCallback(
  server: ResolvedMcpServerDefinition,
  opts: CompleteMcpOAuthCallbackOptions,
): Promise<{ ok: true }> {
  requireOAuthServer(server);
  if (!opts.state || !opts.state.trim()) {
    throw new McpOAuthStateRequiredError(server.name);
  }
  if (!opts.code || !opts.code.trim()) {
    throw new Error(`MCP server "${server.name}" OAuth callback is missing an authorization code`);
  }

  const auth: ResolvedMcpOAuthAuth = { ...server.auth, redirectUrl: opts.redirectUri };
  const provider = new InteractiveMcpOAuthProvider(server.name, auth, { store: opts.store, state: opts.state, logger: opts.logger });

  const result = await sdkAuthorize(provider, { serverUrl: server.url, authorizationCode: opts.code, fetchFn: opts.fetchFn });
  if (result !== "AUTHORIZED") {
    throw new McpOAuthUnexpectedResultError(server.name, "callback", result);
  }
  return { ok: true };
}

/**
 * A bounded in-memory `McpOAuthAuthorizeStore` used by engine unit tests (and available to any caller that
 * wants a simple non-persisting store). The dashboard's real adapter persists tokens/client info as Fusion
 * secret refs into settings — see `packages/dashboard/src/routes.ts`'s `/mcp/oauth/authorize` and
 * `/mcp/oauth/callback` handlers.
 */
export function createInMemoryMcpOAuthAuthorizeStore(): McpOAuthAuthorizeStore & {
  savedTokens: Map<string, McpOAuthTokenBundle>;
  savedClientInfo: Map<string, OAuthClientInformationMixed>;
} {
  const verifiers = new Map<string, string>();
  const savedTokens = new Map<string, McpOAuthTokenBundle>();
  const savedClientInfo = new Map<string, OAuthClientInformationMixed>();
  return {
    savedTokens,
    savedClientInfo,
    async saveTokens(serverName, tokens) {
      savedTokens.set(serverName, tokens);
    },
    async saveClientInformation(serverName, info) {
      savedClientInfo.set(serverName, info);
    },
    async loadClientInformation(serverName) {
      return savedClientInfo.get(serverName);
    },
    async saveCodeVerifier(serverName, verifier) {
      verifiers.set(serverName, verifier);
    },
    async consumeCodeVerifier(serverName) {
      const verifier = verifiers.get(serverName);
      verifiers.delete(serverName);
      return verifier;
    },
  };
}
