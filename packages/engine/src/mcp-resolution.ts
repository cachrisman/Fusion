import {
  materializeMcpServersSecrets,
  resolveEffectiveMcpServers,
  type GlobalSettings,
  type McpOAuthPersistenceStore,
  type McpSecretReader,
  type McpSecretReaderIdentity,
  type McpSecretResolutionError,
  type ProjectSettings,
  type ResolvedMcpServerDefinition,
  type SecretScope,
  type Settings,
} from "@fusion/core";
import { createSettingsBackedMcpOAuthTokenStore, type McpOAuthTokenStore } from "./mcp-oauth-provider.js";

export interface ResolveMcpServersForRuntimeOptions {
  globalSettings?: Pick<GlobalSettings, "mcpServers"> | null;
  projectSettings?: Pick<ProjectSettings, "mcpServers"> | null;
  secrets: McpSecretReader;
  reader?: McpSecretReaderIdentity;
}

export interface ResolvedMcpServersForRuntime {
  servers: ResolvedMcpServerDefinition[];
  errors: McpSecretResolutionError[];
  /**
   * FNXC:McpConfig 2026-07-12-00:00:
   * FUSI-076: `resolveEffectiveMcpServers`'s project-over-global merge collapses which scope each resolved server
   * definition actually came from, but MCP OAuth writeback (FUSI-074's `McpOAuthTokenStore.saveTokens`) must
   * address the SAME scope that owns the server or it will silently migrate/duplicate it. This additive map
   * (server name -> owning scope) is computed alongside `servers` so a caller constructing a
   * `FusionMcpOAuthProvider`/`createHttpMcpTransport` can thread the correct `scope` through provider
   * construction without re-deriving the project-over-global precedence itself.
   */
  scopeByServerName: Record<string, SecretScope>;
}

/**
 * FNXC:McpConfig 2026-06-25-21:43:
 * Runtime MCP forwarding uses Fusion's trusted-once-enabled model: enabled effective servers are materialized once at session/probe creation and then forwarded without per-call prompts. Plaintext env/header values exist only in this in-memory return value and callers must log only counts/errors, never server contents.
 */
export async function resolveMcpServersForRuntime(
  options: ResolveMcpServersForRuntimeOptions,
): Promise<ResolvedMcpServersForRuntime> {
  const effective = resolveEffectiveMcpServers(options.globalSettings, options.projectSettings);
  if (effective.length === 0) return { servers: [], errors: [], scopeByServerName: {} };

  const scopeByServerName = computeScopeByServerName(options.globalSettings, options.projectSettings);
  const materialized = await materializeMcpServersSecrets(
    effective,
    options.secrets,
    options.reader ?? {},
  );
  return {
    servers: materialized.value ?? [],
    errors: materialized.errors,
    scopeByServerName,
  };
}

/**
 * FNXC:McpConfig 2026-07-12-00:00:
 * Mirrors `resolveEffectiveMcpServers`'s project-over-global precedence (an ENABLED project declaration for a
 * name wins; an explicit project `enabled:false` removes the inherited global entry) but tags each surviving
 * name with its owning scope instead of merging away that provenance. Pure and never throws, same as the
 * resolver it mirrors.
 */
function computeScopeByServerName(
  globalSettings?: Pick<GlobalSettings, "mcpServers"> | null,
  projectSettings?: Pick<ProjectSettings, "mcpServers"> | null,
): Record<string, SecretScope> {
  try {
    const scopeByName = new Map<string, SecretScope>();
    for (const server of globalSettings?.mcpServers?.servers ?? []) {
      if (server.enabled === false) continue;
      scopeByName.set(server.name, "global");
    }
    for (const server of projectSettings?.mcpServers?.servers ?? []) {
      if (server.enabled === false) {
        scopeByName.delete(server.name);
        continue;
      }
      scopeByName.set(server.name, "project");
    }
    return Object.fromEntries(scopeByName);
  } catch {
    return {};
  }
}

export interface McpSettingsAndSecretsStore {
  getSettingsByScope?(): Promise<{
    global: Pick<GlobalSettings, "mcpServers">;
    project: Partial<Pick<ProjectSettings, "mcpServers">>;
  }>;
  getSecretsStore?(): Promise<McpSecretReader> | McpSecretReader;
  /** FUSI-076 (optional, additive): project-scope settings writer, needed for OAuth token/client-info writeback. */
  updateSettings?(patch: Partial<Settings>): Promise<unknown>;
  /** FUSI-076 (optional, additive): global-scope settings writer, needed for OAuth token/client-info writeback. */
  updateGlobalSettings?(patch: Partial<GlobalSettings>): Promise<unknown>;
  logger?: Pick<Console, "warn">;
}

const emptyMcpSecretReader: McpSecretReader = {
  async revealSecret() {
    throw new Error("MCP secret reader is unavailable");
  },
};

function isPersistenceCapableSecrets(
  secrets: McpSecretReader,
): secrets is McpSecretReader & McpOAuthPersistenceStore["secrets"] {
  const candidate = secrets as Partial<McpOAuthPersistenceStore["secrets"]>;
  return (
    typeof candidate.listSecrets === "function" &&
    typeof candidate.createSecret === "function" &&
    typeof candidate.updateSecret === "function"
  );
}

/**
 * FNXC:McpConfig 2026-07-12-00:00:
 * FUSI-076 Step 3: builds the REAL `McpOAuthTokenStore` (backed by `@fusion/core`'s engine-free persistence API)
 * from whatever settings/secrets store the caller already has, falling back to `undefined` (callers then fall
 * back to `createWarnOnlyMcpOAuthTokenStore`) only when the store cannot fully address writeback (missing
 * settings writers, or a secrets reader that lacks the create/update/list persistence surface — e.g. a
 * lightweight test double or a reveal-only reader). This is the single builder used by all three MCP consumer
 * paths so the "inject the real store when available" behavior is defined once, not duplicated per call site.
 */
export async function buildMcpOAuthTokenStore(
  store: McpSettingsAndSecretsStore,
): Promise<McpOAuthTokenStore | undefined> {
  if (
    typeof store.getSettingsByScope !== "function" ||
    typeof store.updateSettings !== "function" ||
    typeof store.updateGlobalSettings !== "function" ||
    typeof store.getSecretsStore !== "function"
  ) {
    return undefined;
  }

  const secrets = await store.getSecretsStore();
  if (!isPersistenceCapableSecrets(secrets)) {
    return undefined;
  }

  const persistenceStore: McpOAuthPersistenceStore = {
    getSettingsByScope: () => store.getSettingsByScope!(),
    updateSettings: (patch) => store.updateSettings!(patch),
    updateGlobalSettings: (patch) => store.updateGlobalSettings!(patch),
    secrets,
    logger: store.logger,
  };
  return createSettingsBackedMcpOAuthTokenStore(persistenceStore);
}

export async function resolveMcpServersForStore(
  store: McpSettingsAndSecretsStore,
  reader?: McpSecretReaderIdentity,
): Promise<ResolvedMcpServersForRuntime> {
  /*
   * FNXC:McpConfig 2026-06-26-01:07:
   * Older tests and lightweight TaskStore doubles may not implement the settings/secrets seams because they never configure MCP. Treat those stores as having no enabled MCP servers so all AI lanes keep their existing behavior while real stores still forward the resolved runtime configuration.
   */
  if (typeof store.getSettingsByScope !== "function") {
    return { servers: [], errors: [], scopeByServerName: {} };
  }

  const [settings, secrets] = await Promise.all([
    store.getSettingsByScope(),
    typeof store.getSecretsStore === "function" ? store.getSecretsStore() : emptyMcpSecretReader,
  ]);
  return resolveMcpServersForRuntime({
    globalSettings: settings.global,
    projectSettings: settings.project,
    secrets,
    reader,
  });
}
