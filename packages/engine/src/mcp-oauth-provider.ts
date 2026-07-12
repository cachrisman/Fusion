import { refreshAuthorization, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  saveMcpServerOAuthClientInformation,
  updateMcpServerOAuthTokens,
  type McpOAuthPersistenceStore,
  type ResolvedMcpOAuthAuth,
  type ResolvedMcpServerDefinition,
  type SecretScope,
} from "@fusion/core";

/*
 * FNXC:McpConfig 2026-07-12-00:00:
 * Phase 2 (this module) is the engine-side consumer of FUSI-073's resolved oauth config: a headless
 * `OAuthClientProvider` (satisfying `@modelcontextprotocol/sdk`'s `client/auth.js` interface) plus the single
 * shared HTTP-family transport-construction helper used by all three MCP consumer paths (session-tools,
 * resolution/runtime forwarding, validation probe). The engine NEVER performs interactive authorize —
 * `redirectToAuthorization()` always throws `McpOAuthInteractiveRequiredError` rather than opening a browser or
 * spawning a process. Non-interactive REFRESH happens proactively inside `tokens()`: FUSI-073's absolute
 * `expiresAt` (epoch ms) is checked against `Date.now()`, and an expired-but-refreshable bundle is refreshed via
 * the SDK's own exported `refreshAuthorization()` helper (never a hand-rolled fetch) before being handed back to
 * the SDK transport. A server with no valid/refreshable token throws `McpOAuthNoTokenError` synchronously out of
 * `tokens()` — the SDK calls `tokens()` inside `_commonHeaders()` before every request (first hit is during
 * `Client.connect()`'s initialize handshake), so this throw surfaces promptly at session/probe creation and the
 * three call sites convert it into a fail-soft `skipped` entry with an actionable "needs re-authorize" reason;
 * tools are never silently dropped and the engine never crashes. Token/client-credential writeback goes through
 * the injected `McpOAuthTokenStore` seam as Fusion secret refs — this module never logs or returns plaintext
 * token material. Phase 3 (dashboard) owns interactive one-time authorize + RFC 7591 DCR + RFC 8414 discovery.
 */

/** Thrown by `redirectToAuthorization()` — the engine is headless and must never open a browser. */
export class McpOAuthInteractiveRequiredError extends Error {
  readonly name = "McpOAuthInteractiveRequiredError";
  constructor(serverName: string) {
    super(`MCP server "${serverName}" requires interactive OAuth authorize; the engine cannot perform this non-interactively`);
  }
}

/** Thrown by `tokens()` when no valid/refreshable OAuth token exists for the server. */
export class McpOAuthNoTokenError extends Error {
  readonly name = "McpOAuthNoTokenError";
  constructor(serverName: string) {
    super(`MCP server "${serverName}" has no valid OAuth token; needs re-authorize`);
  }
}

/** Thrown by `tokens()` when a non-interactive refresh attempt fails. */
export class McpOAuthRefreshFailedError extends Error {
  readonly name = "McpOAuthRefreshFailedError";
  constructor(serverName: string, cause?: unknown) {
    super(`MCP server "${serverName}" OAuth token refresh failed; needs re-authorize`);
    if (cause !== undefined) this.cause = cause;
  }
}

/** A user-facing, content-free reason string suitable for a fail-soft `skipped` entry. */
export function describeMcpOAuthError(error: unknown): string | undefined {
  if (error instanceof McpOAuthInteractiveRequiredError) {
    return "oauth: needs re-authorize (interactive authorize required)";
  }
  if (error instanceof McpOAuthNoTokenError) {
    return "oauth: needs re-authorize (no stored token)";
  }
  if (error instanceof McpOAuthRefreshFailedError) {
    return "oauth: needs re-authorize (refresh failed)";
  }
  return undefined;
}

/** Persisted OAuth token bundle, mirroring the resolved oauth fields that are secret-bearing. */
export interface McpOAuthTokenBundle {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

/**
 * FNXC:McpConfig 2026-07-12-00:00:
 * FUSI-076 closes the FUSI-073/074 writeback gap: `saveTokens`/`saveClientInformation` now carry an optional
 * `meta.scope` — the owning settings scope (project vs global) of the server whose stored `auth` block should be
 * rewritten. `scope` is optional (trailing, back-compat) so existing warn-only-store call sites keep compiling
 * unchanged; `createSettingsBackedMcpOAuthTokenStore` below is the real implementation and requires a known scope
 * to actually persist (falls back to a coarse warn when the scope is unknown, never throws).
 */
export interface McpOAuthTokenStore {
  saveTokens(serverName: string, tokens: McpOAuthTokenBundle, meta?: { scope?: SecretScope }): Promise<void>;
  saveClientInformation?(serverName: string, info: OAuthClientInformationMixed, meta?: { scope?: SecretScope }): Promise<void>;
}

/**
 * Default token store used when no persistence seam is injected: warns once (content-free — server name only)
 * and otherwise no-ops. This keeps refresh flows functional in-memory for the current process without crashing,
 * while making the missing writeback wiring visible in logs.
 */
export function createWarnOnlyMcpOAuthTokenStore(logger?: Pick<Console, "warn">): McpOAuthTokenStore {
  return {
    async saveTokens(serverName) {
      logger?.warn?.(`MCP OAuth token refreshed in-memory but not persisted (no token store configured): server=${serverName}`);
    },
    async saveClientInformation(serverName) {
      logger?.warn?.(`MCP OAuth client information not persisted (no token store configured): server=${serverName}`);
    },
  };
}

export interface FusionMcpOAuthProviderOptions {
  tokenStore?: McpOAuthTokenStore;
  logger?: Pick<Console, "warn">;
  /** Owning settings scope (project vs global) of the server this provider addresses — see FUSI-076. */
  scope?: SecretScope;
}

/**
 * Fusion's headless `OAuthClientProvider`. Reads the resolved (already-materialized-from-secret-refs) oauth
 * bundle in-memory; writes refreshed/DCR material back only through the injected `McpOAuthTokenStore`.
 */
export class FusionMcpOAuthProvider implements OAuthClientProvider {
  private bundle: McpOAuthTokenBundle;
  private readonly tokenStore: McpOAuthTokenStore;
  private readonly logger?: Pick<Console, "warn">;
  private readonly scope?: SecretScope;
  private clientInfo: OAuthClientInformationMixed | undefined;

  constructor(
    private readonly serverName: string,
    private readonly auth: ResolvedMcpOAuthAuth,
    options: FusionMcpOAuthProviderOptions = {},
  ) {
    this.bundle = {
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
      expiresAt: auth.expiresAt,
    };
    this.tokenStore = options.tokenStore ?? createWarnOnlyMcpOAuthTokenStore(options.logger);
    this.logger = options.logger;
    this.scope = options.scope;
    this.clientInfo = auth.clientId ? { client_id: auth.clientId, client_secret: auth.clientSecret } : undefined;
  }

  get redirectUrl(): string | URL | undefined {
    return this.auth.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: this.auth.redirectUrl ? [this.auth.redirectUrl] : [],
      client_name: "Fusion",
      scope: this.auth.scopes?.join(" "),
    } as OAuthClientMetadata;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.clientInfo;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    this.clientInfo = clientInformation;
    await this.tokenStore.saveClientInformation?.(this.serverName, clientInformation, { scope: this.scope });
  }

  /**
   * Returns the current token bundle mapped to the SDK's `OAuthTokens` shape, performing a non-interactive
   * proactive refresh first when the stored access token is expired but a refresh token is available. Throws
   * `McpOAuthNoTokenError` when no valid/refreshable token exists at all, and `McpOAuthRefreshFailedError` when a
   * refresh attempt fails — both are engine-fail-soft signals, never a crash and never an interactive prompt.
   */
  async tokens(): Promise<OAuthTokens | undefined> {
    const isExpired = typeof this.bundle.expiresAt === "number" && this.bundle.expiresAt <= Date.now();
    if (this.bundle.accessToken && !isExpired) {
      return this.toOAuthTokens(this.bundle);
    }
    if (this.bundle.refreshToken) {
      try {
        const refreshed = await this.performRefresh(this.bundle.refreshToken);
        this.bundle = refreshed;
        await this.tokenStore.saveTokens(this.serverName, refreshed, { scope: this.scope });
        return this.toOAuthTokens(refreshed);
      } catch (error) {
        throw new McpOAuthRefreshFailedError(this.serverName, error);
      }
    }
    throw new McpOAuthNoTokenError(this.serverName);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const expiresAt = typeof tokens.expires_in === "number" ? Date.now() + tokens.expires_in * 1000 : undefined;
    const bundle: McpOAuthTokenBundle = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? this.bundle.refreshToken,
      expiresAt,
    };
    this.bundle = bundle;
    await this.tokenStore.saveTokens(this.serverName, bundle, { scope: this.scope });
  }

  redirectToAuthorization(): void {
    // FNXC:McpConfig 2026-07-12-00:00: The engine is headless — it never opens a browser or spawns a process.
    // This typed throw is caught at the three MCP consumer call sites and converted to a fail-soft skip.
    throw new McpOAuthInteractiveRequiredError(this.serverName);
  }

  async saveCodeVerifier(): Promise<void> {
    // The engine never performs the interactive authorization-code exchange; only non-interactive refresh is
    // supported here (Phase 3 dashboard owns the interactive flow and its PKCE code-verifier persistence).
    throw new McpOAuthInteractiveRequiredError(this.serverName);
  }

  async codeVerifier(): Promise<string> {
    throw new McpOAuthInteractiveRequiredError(this.serverName);
  }

  private toOAuthTokens(bundle: McpOAuthTokenBundle): OAuthTokens {
    const expiresIn = typeof bundle.expiresAt === "number" ? Math.max(0, Math.round((bundle.expiresAt - Date.now()) / 1000)) : undefined;
    return {
      access_token: bundle.accessToken ?? "",
      token_type: "Bearer",
      ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}),
      ...(bundle.refreshToken ? { refresh_token: bundle.refreshToken } : {}),
      ...(this.auth.scopes ? { scope: this.auth.scopes.join(" ") } : {}),
    };
  }

  private async performRefresh(refreshToken: string): Promise<McpOAuthTokenBundle> {
    if (!this.auth.clientId) {
      throw new Error("cannot refresh OAuth token: no clientId is configured for this server");
    }
    const clientInformation: OAuthClientInformationMixed = this.clientInfo ?? {
      client_id: this.auth.clientId,
      client_secret: this.auth.clientSecret,
    };
    const tokens = await refreshAuthorization(this.auth.authorizationServerUrl, {
      clientInformation,
      refreshToken,
    });
    const expiresAt = typeof tokens.expires_in === "number" ? Date.now() + tokens.expires_in * 1000 : undefined;
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? refreshToken,
      expiresAt,
    };
  }
}

export function createFusionMcpOAuthProvider(
  serverName: string,
  auth: ResolvedMcpOAuthAuth,
  options: FusionMcpOAuthProviderOptions = {},
): FusionMcpOAuthProvider {
  return new FusionMcpOAuthProvider(serverName, auth, options);
}

export interface CreateHttpMcpTransportOptions {
  tokenStore?: McpOAuthTokenStore;
  logger?: Pick<Console, "warn">;
  /** Owning settings scope (project vs global) of `server` — threaded to the provider for writeback addressing. */
  scope?: SecretScope;
}

type HttpMcpServer = Extract<ResolvedMcpServerDefinition, { transport: "sse" | "streamable-http" }>;

/**
 * FNXC:McpConfig 2026-07-12-00:00:
 * Single shared HTTP-family transport-construction helper — the anti-drift seam required by AGENTS.md's
 * "Fix the Invariant, Not the Repro" rule. All three MCP consumer paths (session-tools, resolution/runtime
 * forwarding, validation probe) MUST call this instead of constructing `SSEClientTransport`/
 * `StreamableHTTPClientTransport` independently. Builds the existing header `requestInit`/`eventSourceInit`
 * wiring unchanged, and additionally attaches a `FusionMcpOAuthProvider` built from the resolved oauth `auth`
 * block when present (headers-only servers with no `auth` behave exactly as before — additive, no drift).
 */
export function createHttpMcpTransport(server: HttpMcpServer, opts: CreateHttpMcpTransportOptions = {}): Transport {
  const headers = server.headers;
  const requestInit = headers ? { headers } : undefined;
  const authProvider = server.auth
    ? createFusionMcpOAuthProvider(server.name, server.auth, { tokenStore: opts.tokenStore, logger: opts.logger, scope: opts.scope })
    : undefined;

  if (server.transport === "sse") {
    return new SSEClientTransport(new URL(server.url), {
      eventSourceInit: requestInit ? { fetch: (input, init) => fetch(input, { ...init, ...requestInit }) } : undefined,
      requestInit,
      authProvider,
    });
  }
  return new StreamableHTTPClientTransport(new URL(server.url), { requestInit, authProvider });
}

/** True when the resolved server carries an oauth `auth` block (HTTP-family only; stdio never does). */
export function hasMcpOAuthAuth(server: ResolvedMcpServerDefinition): server is HttpMcpServer & { auth: ResolvedMcpOAuthAuth } {
  return server.transport !== "stdio" && Boolean((server as HttpMcpServer).auth);
}

/**
 * FNXC:McpConfig 2026-07-12-00:00:
 * FUSI-076 Step 2: the real `McpOAuthTokenStore` implementation, built on `@fusion/core`'s engine-free
 * `updateMcpServerOAuthTokens` / `saveMcpServerOAuthClientInformation` persistence API (the same seam the
 * Phase-3 dashboard authorize/callback flow, FUSI-075, will reuse). Maps the SDK's relative `saveTokens`
 * `OAuthTokens`/`OAuthClientInformationMixed` shapes (already normalized to `McpOAuthTokenBundle` by
 * `FusionMcpOAuthProvider` before this store is called) onto the core API's `{ serverName, scope, ... }`
 * addressing. `meta.scope` is REQUIRED to actually persist — without it (e.g. a caller that has not threaded
 * scope through provider construction) this store fail-softs to a coarse, content-free warn and does not throw,
 * mirroring `createWarnOnlyMcpOAuthTokenStore`'s contract. Never logs token/refresh-token/client-secret
 * material — only server name / scope / coarse outcome.
 */
export function createSettingsBackedMcpOAuthTokenStore(persistenceStore: McpOAuthPersistenceStore): McpOAuthTokenStore {
  return {
    async saveTokens(serverName, tokens, meta) {
      if (!meta?.scope) {
        persistenceStore.logger?.warn?.(
          `MCP OAuth token refreshed in-memory but not persisted (owning scope unknown): server=${serverName}`,
        );
        return;
      }
      try {
        const result = await updateMcpServerOAuthTokens(
          {
            serverName,
            scope: meta.scope,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
          },
          persistenceStore,
        );
        if (!result.persisted) {
          persistenceStore.logger?.warn?.(
            `MCP OAuth token persist skipped: server=${serverName} scope=${meta.scope} reason=${result.reason}`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        persistenceStore.logger?.warn?.(`MCP OAuth token persist failed: server=${serverName} scope=${meta.scope} error=${message}`);
      }
    },
    async saveClientInformation(serverName, info, meta) {
      if (!meta?.scope) {
        persistenceStore.logger?.warn?.(
          `MCP OAuth client information not persisted (owning scope unknown): server=${serverName}`,
        );
        return;
      }
      const clientId = typeof info.client_id === "string" ? info.client_id : undefined;
      if (!clientId) {
        persistenceStore.logger?.warn?.(`MCP OAuth client information not persisted (no client_id): server=${serverName} scope=${meta.scope}`);
        return;
      }
      const clientSecret = typeof info.client_secret === "string" ? info.client_secret : undefined;
      try {
        const result = await saveMcpServerOAuthClientInformation({ serverName, scope: meta.scope, clientId, clientSecret }, persistenceStore);
        if (!result.persisted) {
          persistenceStore.logger?.warn?.(
            `MCP OAuth client information persist skipped: server=${serverName} scope=${meta.scope} reason=${result.reason}`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        persistenceStore.logger?.warn?.(
          `MCP OAuth client information persist failed: server=${serverName} scope=${meta.scope} error=${message}`,
        );
      }
    },
  };
}
