import { superviseSpawn, type SupervisedChild } from "@fusion/core";
import type { ResolvedMcpServerDefinition, SecretScope } from "@fusion/core";
import { createFusionMcpOAuthProvider, describeMcpOAuthError, type McpOAuthTokenStore } from "./mcp-oauth-provider.js";
import { buildMcpOAuthTokenStore, type McpSettingsAndSecretsStore } from "./mcp-resolution.js";

export type McpValidationStatus = "valid" | "unreachable" | "error";

export interface McpValidationResult {
  status: McpValidationStatus;
  message?: string;
}

export interface McpStdioProbeOptions {
  timeoutMs: number;
  cwd?: string;
}

export type McpStdioProbe = (
  server: Extract<ResolvedMcpServerDefinition, { transport: "stdio" }>,
  options: McpStdioProbeOptions,
) => Promise<McpValidationResult>;

export type McpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ValidateMcpServerOptions {
  timeoutMs?: number;
  cwd?: string;
  stdioProbe?: McpStdioProbe;
  fetchImpl?: McpFetch;
  /** Injected OAuth token writeback seam (secret-ref persistence); see mcp-oauth-provider.ts. */
  oauthTokenStore?: McpOAuthTokenStore;
  /**
   * FNXC:McpConfig 2026-07-12-00:00:
   * FUSI-076 Step 3: when `oauthTokenStore` is not explicitly supplied, a settings/secrets-capable store here
   * lets the probe build the REAL persisted token store instead of falling back to warn-only. Additive — no
   * drift for existing callers that supply neither.
   */
  mcpSettingsStore?: McpSettingsAndSecretsStore;
  /** Owning scope (project vs global) of the server being probed; needed to address writeback correctly. */
  scope?: SecretScope;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const SIGKILL_GRACE_MS = 1_000;

/**
 * FNXC:McpConfig 2026-06-25-23:26:
 * MCP validation probes are bounded and content-free: stdio uses superviseSpawn with a lifetime cap, HTTP transports use AbortController timeouts, and neither path logs or returns resolved env/header secret values.
 */
export async function validateMcpServer(
  server: ResolvedMcpServerDefinition,
  options: ValidateMcpServerOptions = {},
): Promise<McpValidationResult> {
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  if (server.transport === "stdio") {
    return (options.stdioProbe ?? defaultStdioProbe)(server, { timeoutMs, cwd: options.cwd });
  }

  const oauthTokenStore = options.oauthTokenStore ?? (options.mcpSettingsStore ? await buildMcpOAuthTokenStore(options.mcpSettingsStore) : undefined);

  return validateHttpMcpServer(server, {
    timeoutMs,
    fetchImpl: options.fetchImpl ?? globalThis.fetch?.bind(globalThis),
    oauthTokenStore,
    scope: options.scope,
  });
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  return Number.isFinite(timeoutMs) && timeoutMs !== undefined && timeoutMs > 0
    ? Math.min(timeoutMs, 30_000)
    : DEFAULT_TIMEOUT_MS;
}

/*
 * FNXC:McpConfig 2026-07-12-00:00:
 * FUSI-074 Step 5: the bounded HTTP probe stays a plain GET (not a full MCP handshake), but when the resolved
 * server carries an oauth `auth` block we obtain a bearer token from the same `FusionMcpOAuthProvider` used by
 * the other two consumer paths — including its non-interactive proactive refresh — before probing. A no-token /
 * refresh-failed / interactive-required condition is content-free-mapped to an actionable `status: "error"`
 * message rather than crashing or ever opening a browser; the AbortController timeout budget is unchanged.
 */
async function validateHttpMcpServer(
  server: Extract<ResolvedMcpServerDefinition, { transport: "sse" | "streamable-http" }>,
  options: { timeoutMs: number; fetchImpl?: McpFetch; oauthTokenStore?: McpOAuthTokenStore; scope?: SecretScope },
): Promise<McpValidationResult> {
  if (!options.fetchImpl) {
    return { status: "error", message: "fetch is unavailable in this runtime" };
  }

  let headers = server.headers;
  if (server.auth) {
    const provider = createFusionMcpOAuthProvider(server.name, server.auth, { tokenStore: options.oauthTokenStore, scope: options.scope });
    try {
      const tokens = await provider.tokens();
      if (tokens?.access_token) {
        headers = { ...headers, Authorization: `Bearer ${tokens.access_token}` };
      }
    } catch (error) {
      const reason = describeMcpOAuthError(error);
      return { status: "error", message: reason ?? "oauth: needs re-authorize" };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.fetchImpl(server.url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (response.status >= 500) {
      return { status: "error", message: `server responded with HTTP ${response.status}` };
    }

    return { status: "valid", message: `server responded with HTTP ${response.status}` };
  } catch (error) {
    if (isAbortError(error)) {
      return { status: "unreachable", message: "connection timed out" };
    }
    return { status: "unreachable", message: errorMessage(error, "connection failed") };
  } finally {
    clearTimeout(timer);
  }
}

async function defaultStdioProbe(
  server: Extract<ResolvedMcpServerDefinition, { transport: "stdio" }>,
  options: McpStdioProbeOptions,
): Promise<McpValidationResult> {
  let supervised: SupervisedChild;
  try {
    supervised = superviseSpawn(server.command, server.args ?? [], {
      cwd: options.cwd,
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        ...process.env,
        ...(server.env ?? {}),
      },
      killGraceMs: SIGKILL_GRACE_MS,
      maxLifetimeMs: options.timeoutMs + SIGKILL_GRACE_MS,
    });
  } catch (error) {
    return { status: "error", message: errorMessage(error, "failed to start stdio server") };
  }

  return new Promise<McpValidationResult>((resolve) => {
    let settled = false;
    const settle = (result: McpValidationResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      supervised.kill("SIGTERM");
      settle({ status: "valid", message: "stdio server stayed reachable through the probe window" });
    }, options.timeoutMs);

    supervised.child.once("error", (error) => {
      settle({ status: "error", message: errorMessage(error, "stdio probe failed") });
    });

    supervised.waitExit().then((exit) => {
      if (exit.code === 0) {
        settle({ status: "valid", message: "stdio command exited successfully" });
      } else {
        settle({ status: "unreachable", message: `stdio command exited with ${exit.signal ?? exit.code ?? "unknown status"}` });
      }
    }).catch((error) => {
      settle({ status: "error", message: errorMessage(error, "stdio probe failed") });
    });
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}
