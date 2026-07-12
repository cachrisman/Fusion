import type { GlobalSettings, McpOAuthAuth, McpServerDefinition, McpServersSettings, ProjectSettings, Settings } from "./types.js";
import type { SecretScope } from "./secrets-store.js";

/*
 * FNXC:McpConfig 2026-07-12-00:00:
 * FUSI-076 closes the writeback gap FUSI-074 deferred: FUSI-073's `McpOAuthAuth` config shape has no field the
 * engine can use to address (rewrite) an existing server's stored secret refs after a non-interactive refresh, so
 * FUSI-074 shipped writeback as a warn-only no-op (`createWarnOnlyMcpOAuthTokenStore`). This module is the real,
 * engine-free, scope-aware persistence path: `updateMcpServerOAuthTokens` / `saveMcpServerOAuthClientInformation`
 * take an explicit `{ serverName, scope }` address (the caller — FUSI-074's engine adapter, or the Phase-3
 * dashboard authorize/callback flow, FUSI-075 — supplies the owning scope; this module never guesses it or
 * collapses project-over-global inheritance) plus a new token/client-info bundle, and:
 *   1. create-or-update the backing Fusion secret(s) idempotently (deterministic per-field secret key, reuse an
 *      existing secret id in place — never a duplicate secret on repeated refresh);
 *   2. rewrite ONLY the matching stored `McpServerDefinition.auth` block's secret refs (+ non-secret `expiresAt`)
 *      in the SAME scope that owns the server, preserving every other field/server untouched;
 *   3. fail-soft (never throw) when the named server no longer exists in the owning scope at writeback time —
 *      this can happen when a refresh completes concurrently with a delete/rename — returning a coarse
 *      `{ persisted: false, reason }` instead of surfacing into the live (already-succeeded-in-memory) refresh
 *      path or creating an orphaned `auth` block on a nonexistent server.
 * Content-free logging: only server name / scope / coarse outcome are ever passed to a logger — never token,
 * refresh-token, client-secret, or authorization-server values. This API is intentionally free of any
 * `@fusion/engine`/`@fusion/dashboard` import so it is the SAME persistence seam consumed by both the engine's
 * non-interactive refresh (FUSI-074's `createSettingsBackedMcpOAuthTokenStore`) and the Phase-3 dashboard
 * authorize/callback route (FUSI-075) — see AGENTS.md "Importing across `@fusion/*` packages".
 */

/** Narrow secrets-store seam this module depends on (unit-testable without a full `SecretsStore`/DB). */
export interface McpOAuthPersistenceSecretsSeam {
  listSecrets(scope: SecretScope): Array<{ id: string; key: string }>;
  createSecret(input: {
    scope: SecretScope;
    key: string;
    plaintextValue: string;
    description?: string | null;
  }): Promise<{ id: string }>;
  updateSecret(id: string, scope: SecretScope, patch: { plaintextValue?: string }): Promise<unknown>;
}

/** Narrow settings-store seam this module depends on (unit-testable with in-memory fakes). */
export interface McpOAuthPersistenceStore {
  getSettingsByScope(): Promise<{
    global: Pick<GlobalSettings, "mcpServers">;
    project: Partial<Pick<ProjectSettings, "mcpServers">>;
  }>;
  updateSettings(patch: Partial<Settings>): Promise<unknown>;
  updateGlobalSettings(patch: Partial<GlobalSettings>): Promise<unknown>;
  secrets: McpOAuthPersistenceSecretsSeam;
  /** Content-free logger; only server name / scope / coarse outcome are ever passed. */
  logger?: Pick<Console, "warn">;
}

export interface McpOAuthTokenPersistInput {
  serverName: string;
  scope: SecretScope;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface McpOAuthClientInformationPersistInput {
  serverName: string;
  scope: SecretScope;
  clientId: string;
  clientSecret?: string;
}

export type McpOAuthPersistFailureReason = "server-not-found" | "no-auth-block" | "no-fields" | "error";

export type McpOAuthPersistResult =
  | { persisted: true; fieldsWritten: string[] }
  | { persisted: false; reason: McpOAuthPersistFailureReason };

function suggestedOAuthSecretKey(serverName: string, field: "accessToken" | "refreshToken" | "clientSecret"): string {
  const slug = serverName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "server";
  return `mcp.${slug}.oauth.${field}`;
}

/**
 * Idempotently create-or-update a single secret-bearing field: reuse the existing secret id addressed by the
 * current `auth` block when present, else reuse an existing secret with the same deterministic key (never a
 * duplicate), else create a new one. Returns the secret ref to store back on the `auth` block.
 */
async function upsertOAuthSecretField(params: {
  scope: SecretScope;
  key: string;
  plaintextValue: string;
  existingRef?: { secretRef: string } | string;
  secrets: McpOAuthPersistenceSecretsSeam;
}): Promise<{ secretRef: string; scope: SecretScope }> {
  const { scope, key, plaintextValue, existingRef, secrets } = params;

  const existingId = existingRef && typeof existingRef === "object" ? existingRef.secretRef : undefined;
  if (existingId) {
    await secrets.updateSecret(existingId, scope, { plaintextValue });
    return { secretRef: existingId, scope };
  }

  const existingByKey = secrets.listSecrets(scope).find((s) => s.key === key);
  if (existingByKey) {
    await secrets.updateSecret(existingByKey.id, scope, { plaintextValue });
    return { secretRef: existingByKey.id, scope };
  }

  const created = await secrets.createSecret({ scope, key, plaintextValue, description: `MCP OAuth ${key}` });
  return { secretRef: created.id, scope };
}

function serversForScope(settings: { global: Pick<GlobalSettings, "mcpServers">; project: Partial<Pick<ProjectSettings, "mcpServers">> }, scope: SecretScope): McpServersSettings | undefined {
  return scope === "project" ? settings.project.mcpServers : settings.global.mcpServers;
}

async function persistServersForScope(store: McpOAuthPersistenceStore, scope: SecretScope, mcpServers: McpServersSettings): Promise<void> {
  if (scope === "project") {
    await store.updateSettings({ mcpServers } as Partial<Settings>);
  } else {
    await store.updateGlobalSettings({ mcpServers } as Partial<GlobalSettings>);
  }
}

/**
 * Persist a refreshed OAuth token bundle: create-or-update the backing secret(s) and rewrite the matching stored
 * server's `auth.accessToken` / `auth.refreshToken` / `auth.expiresAt`. Re-reads the owning scope's settings
 * immediately before writing (never caches a stale array). Fail-soft: never throws; a missing server or missing
 * `auth` block returns a coarse `persisted: false` result instead of creating an orphaned auth block.
 */
export async function updateMcpServerOAuthTokens(
  input: McpOAuthTokenPersistInput,
  store: McpOAuthPersistenceStore,
): Promise<McpOAuthPersistResult> {
  const { serverName, scope } = input;
  try {
    const settings = await store.getSettingsByScope();
    const mcpServers = serversForScope(settings, scope);
    const servers = mcpServers?.servers ?? [];
    const index = servers.findIndex((s) => s.name === serverName);
    if (index === -1) {
      store.logger?.warn?.(`MCP OAuth token persist skipped: server not found in owning scope (server=${serverName} scope=${scope})`);
      return { persisted: false, reason: "server-not-found" };
    }

    const server = servers[index]!;
    if (server.transport === "stdio" || !server.auth) {
      store.logger?.warn?.(`MCP OAuth token persist skipped: server has no oauth auth block (server=${serverName} scope=${scope})`);
      return { persisted: false, reason: "no-auth-block" };
    }

    const fieldsWritten: string[] = [];
    const nextAuth: McpOAuthAuth = { ...server.auth };

    if (input.accessToken !== undefined) {
      const ref = await upsertOAuthSecretField({
        scope,
        key: suggestedOAuthSecretKey(serverName, "accessToken"),
        plaintextValue: input.accessToken,
        existingRef: server.auth.accessToken,
        secrets: store.secrets,
      });
      nextAuth.accessToken = ref;
      fieldsWritten.push("accessToken");
    }
    if (input.refreshToken !== undefined) {
      const ref = await upsertOAuthSecretField({
        scope,
        key: suggestedOAuthSecretKey(serverName, "refreshToken"),
        plaintextValue: input.refreshToken,
        existingRef: server.auth.refreshToken,
        secrets: store.secrets,
      });
      nextAuth.refreshToken = ref;
      fieldsWritten.push("refreshToken");
    }
    if (input.expiresAt !== undefined) {
      nextAuth.expiresAt = input.expiresAt;
      fieldsWritten.push("expiresAt");
    }

    if (fieldsWritten.length === 0) {
      return { persisted: false, reason: "no-fields" };
    }

    const updatedServers: McpServerDefinition[] = servers.map((s, i) => (i === index ? { ...s, auth: nextAuth } : s));
    await persistServersForScope(store, scope, { ...mcpServers, servers: updatedServers });

    store.logger?.warn?.(`MCP OAuth token persisted: server=${serverName} scope=${scope} fields=${fieldsWritten.length}`);
    return { persisted: true, fieldsWritten };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.logger?.warn?.(`MCP OAuth token persist failed (server=${serverName} scope=${scope}): ${message}`);
    return { persisted: false, reason: "error" };
  }
}

/**
 * Persist RFC 7591 DCR client information (`clientId` non-secret + optional `clientSecret` secret) onto the
 * matching stored server's `auth` block, in the scope that owns it. Same fail-soft / idempotent-secret /
 * scope-correct contract as `updateMcpServerOAuthTokens`.
 */
export async function saveMcpServerOAuthClientInformation(
  input: McpOAuthClientInformationPersistInput,
  store: McpOAuthPersistenceStore,
): Promise<McpOAuthPersistResult> {
  const { serverName, scope } = input;
  try {
    const settings = await store.getSettingsByScope();
    const mcpServers = serversForScope(settings, scope);
    const servers = mcpServers?.servers ?? [];
    const index = servers.findIndex((s) => s.name === serverName);
    if (index === -1) {
      store.logger?.warn?.(`MCP OAuth client information persist skipped: server not found in owning scope (server=${serverName} scope=${scope})`);
      return { persisted: false, reason: "server-not-found" };
    }

    const server = servers[index]!;
    if (server.transport === "stdio" || !server.auth) {
      store.logger?.warn?.(`MCP OAuth client information persist skipped: server has no oauth auth block (server=${serverName} scope=${scope})`);
      return { persisted: false, reason: "no-auth-block" };
    }

    const fieldsWritten: string[] = [];
    const nextAuth: McpOAuthAuth = { ...server.auth, clientId: input.clientId };
    fieldsWritten.push("clientId");

    if (input.clientSecret !== undefined) {
      const ref = await upsertOAuthSecretField({
        scope,
        key: suggestedOAuthSecretKey(serverName, "clientSecret"),
        plaintextValue: input.clientSecret,
        existingRef: server.auth.clientSecret,
        secrets: store.secrets,
      });
      nextAuth.clientSecret = ref;
      fieldsWritten.push("clientSecret");
    }

    const updatedServers: McpServerDefinition[] = servers.map((s, i) => (i === index ? { ...s, auth: nextAuth } : s));
    await persistServersForScope(store, scope, { ...mcpServers, servers: updatedServers });

    store.logger?.warn?.(`MCP OAuth client information persisted: server=${serverName} scope=${scope} fields=${fieldsWritten.length}`);
    return { persisted: true, fieldsWritten };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.logger?.warn?.(`MCP OAuth client information persist failed (server=${serverName} scope=${scope}): ${message}`);
    return { persisted: false, reason: "error" };
  }
}
