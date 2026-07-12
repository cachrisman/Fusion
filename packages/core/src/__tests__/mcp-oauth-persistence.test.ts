import { describe, expect, it } from "vitest";
import {
  saveMcpServerOAuthClientInformation,
  updateMcpServerOAuthTokens,
  type McpOAuthPersistenceStore,
} from "../mcp-oauth-persistence.js";
import { materializeMcpServerSecrets } from "../mcp-config.js";
import type { GlobalSettings, McpServerDefinition, ProjectSettings } from "../types.js";
import type { SecretScope } from "../secrets-store.js";

interface FakeSecretRecord {
  id: string;
  scope: SecretScope;
  key: string;
  plaintextValue: string;
}

/** Minimal in-memory fake satisfying `McpOAuthPersistenceStore` (no DB, no @fusion/engine — FN-5048). */
function createFakeStore(params: {
  global?: Pick<GlobalSettings, "mcpServers">;
  project?: Partial<Pick<ProjectSettings, "mcpServers">>;
}): { store: McpOAuthPersistenceStore; secretRecords: FakeSecretRecord[]; loggedMessages: string[] } {
  let global: Pick<GlobalSettings, "mcpServers"> = params.global ?? { mcpServers: { enabled: true, servers: [] } };
  let project: Partial<Pick<ProjectSettings, "mcpServers">> = params.project ?? {};
  const secretRecords: FakeSecretRecord[] = [];
  const loggedMessages: string[] = [];
  let nextId = 1;

  const store: McpOAuthPersistenceStore = {
    async getSettingsByScope() {
      return { global, project };
    },
    async updateSettings(patch) {
      project = { ...project, ...(patch as Partial<ProjectSettings>) };
      return project;
    },
    async updateGlobalSettings(patch) {
      global = { ...global, ...(patch as Pick<GlobalSettings, "mcpServers">) };
      return global;
    },
    secrets: {
      listSecrets(scope) {
        return secretRecords.filter((s) => s.scope === scope).map((s) => ({ id: s.id, key: s.key }));
      },
      async createSecret(input) {
        const id = `secret-${nextId++}`;
        secretRecords.push({ id, scope: input.scope, key: input.key, plaintextValue: input.plaintextValue });
        return { id };
      },
      async updateSecret(id, scope, patch) {
        const existing = secretRecords.find((s) => s.id === id && s.scope === scope);
        if (!existing) throw new Error("secret not found");
        if (patch.plaintextValue !== undefined) existing.plaintextValue = patch.plaintextValue;
        return existing;
      },
    },
    logger: { warn: (message: string) => loggedMessages.push(message) },
  };

  return { store, secretRecords, loggedMessages };
}

function oauthServer(overrides: Partial<McpServerDefinition> = {}): McpServerDefinition {
  return {
    name: "asana",
    transport: "sse",
    url: "https://mcp.example/asana",
    auth: {
      type: "oauth",
      authorizationServerUrl: "https://auth.example.test",
      clientId: "client-1",
    },
    ...overrides,
  } as McpServerDefinition;
}

const secretsReader = (records: FakeSecretRecord[]) => ({
  async revealSecret(id: string, scope: SecretScope) {
    const found = records.find((r) => r.id === id && r.scope === scope);
    if (!found) throw new Error("not found");
    return { key: found.key, plaintextValue: found.plaintextValue };
  },
});

describe("updateMcpServerOAuthTokens", () => {
  it("first-time persistence creates secrets and writes secret refs + expiresAt in project scope", async () => {
    const { store, secretRecords } = createFakeStore({ project: { mcpServers: { enabled: true, servers: [oauthServer()] } } });

    const result = await updateMcpServerOAuthTokens(
      { serverName: "asana", scope: "project", accessToken: "at-1", refreshToken: "rt-1", expiresAt: 1000 },
      store,
    );

    expect(result).toEqual({ persisted: true, fieldsWritten: ["accessToken", "refreshToken", "expiresAt"] });
    expect(secretRecords).toHaveLength(2);
    expect(secretRecords.map((s) => s.key)).toEqual(["mcp.asana.oauth.accessToken", "mcp.asana.oauth.refreshToken"]);

    const settings = await store.getSettingsByScope();
    const server = settings.project.mcpServers?.servers?.[0];
    expect(server?.auth).toMatchObject({ expiresAt: 1000 });
    expect((server?.auth as { accessToken?: unknown })?.accessToken).toEqual({ secretRef: secretRecords[0]!.id, scope: "project" });

    // Prove the refreshed token survives a re-read via materializeMcpServerSecrets (closes the FUSI-074 stub gap).
    const materialized = await materializeMcpServerSecrets(server!, secretsReader(secretRecords), {});
    expect(materialized.value).toMatchObject({ auth: { accessToken: "at-1", refreshToken: "rt-1" } });
  });

  it("update-in-place reuses the existing secret id on repeated refresh (no duplicate secret)", async () => {
    const { store, secretRecords } = createFakeStore({ project: { mcpServers: { enabled: true, servers: [oauthServer()] } } });

    await updateMcpServerOAuthTokens({ serverName: "asana", scope: "project", accessToken: "at-1" }, store);
    expect(secretRecords).toHaveLength(1);
    const firstId = secretRecords[0]!.id;

    await updateMcpServerOAuthTokens({ serverName: "asana", scope: "project", accessToken: "at-2" }, store);
    expect(secretRecords).toHaveLength(1);
    expect(secretRecords[0]!.id).toBe(firstId);
    expect(secretRecords[0]!.plaintextValue).toBe("at-2");
  });

  it("reuses an existing secret by deterministic key even when the auth block's ref was orphaned", async () => {
    const { store, secretRecords } = createFakeStore({ project: { mcpServers: { enabled: true, servers: [oauthServer()] } } });
    // Pre-seed a secret with the deterministic key but no ref on the auth block yet (simulates a prior write
    // whose settings write raced/failed after the secret was created).
    secretRecords.push({ id: "preexisting-1", scope: "project", key: "mcp.asana.oauth.accessToken", plaintextValue: "stale" });

    await updateMcpServerOAuthTokens({ serverName: "asana", scope: "project", accessToken: "at-new" }, store);

    expect(secretRecords).toHaveLength(1);
    expect(secretRecords[0]!.id).toBe("preexisting-1");
    expect(secretRecords[0]!.plaintextValue).toBe("at-new");
  });

  it("writes to the scope that owns the server: project-over-global does not migrate a global server", async () => {
    const globalServer = oauthServer({ name: "linear" });
    const { store, secretRecords } = createFakeStore({
      global: { mcpServers: { enabled: true, servers: [globalServer] } },
      project: { mcpServers: { enabled: true, servers: [] } },
    });

    const result = await updateMcpServerOAuthTokens({ serverName: "linear", scope: "global", accessToken: "at-1" }, store);
    expect(result).toEqual({ persisted: true, fieldsWritten: ["accessToken"] });

    const settings = await store.getSettingsByScope();
    expect(settings.global.mcpServers?.servers?.[0]?.auth).toMatchObject({});
    expect(settings.project.mcpServers?.servers ?? []).toEqual([]);
    expect(secretRecords[0]!.scope).toBe("global");
  });

  it("does not touch other servers or unrelated auth fields", async () => {
    const other = oauthServer({ name: "other-server", url: "https://mcp.example/other" });
    const target = oauthServer({
      auth: {
        type: "oauth",
        authorizationServerUrl: "https://auth.example.test",
        clientId: "client-1",
        scopes: ["read", "write"],
        redirectUrl: "https://fusion.example/callback",
      },
    });
    const { store } = createFakeStore({ project: { mcpServers: { enabled: true, servers: [other, target] } } });

    await updateMcpServerOAuthTokens({ serverName: "asana", scope: "project", accessToken: "at-1" }, store);

    const settings = await store.getSettingsByScope();
    const servers = settings.project.mcpServers?.servers ?? [];
    expect(servers[0]).toEqual(other);
    expect(servers[1]?.auth).toMatchObject({
      authorizationServerUrl: "https://auth.example.test",
      clientId: "client-1",
      scopes: ["read", "write"],
      redirectUrl: "https://fusion.example/callback",
    });
  });

  it("access-only refresh omits refreshToken/expiresAt from fieldsWritten", async () => {
    const { store } = createFakeStore({ project: { mcpServers: { enabled: true, servers: [oauthServer()] } } });
    const result = await updateMcpServerOAuthTokens({ serverName: "asana", scope: "project", accessToken: "at-1" }, store);
    expect(result).toEqual({ persisted: true, fieldsWritten: ["accessToken"] });
  });

  it("access + refresh rotation persists both new tokens", async () => {
    const { store, secretRecords } = createFakeStore({ project: { mcpServers: { enabled: true, servers: [oauthServer()] } } });
    await updateMcpServerOAuthTokens({ serverName: "asana", scope: "project", accessToken: "at-1", refreshToken: "rt-1" }, store);
    await updateMcpServerOAuthTokens({ serverName: "asana", scope: "project", accessToken: "at-2", refreshToken: "rt-2" }, store);
    expect(secretRecords).toHaveLength(2);
    expect(secretRecords.find((s) => s.key.includes("accessToken"))?.plaintextValue).toBe("at-2");
    expect(secretRecords.find((s) => s.key.includes("refreshToken"))?.plaintextValue).toBe("rt-2");
  });

  it("fails soft with server-not-found when the named server no longer exists (never throws, no orphaned auth)", async () => {
    const { store, secretRecords, loggedMessages } = createFakeStore({ project: { mcpServers: { enabled: true, servers: [] } } });
    const result = await updateMcpServerOAuthTokens({ serverName: "gone", scope: "project", accessToken: "at-1" }, store);
    expect(result).toEqual({ persisted: false, reason: "server-not-found" });
    expect(secretRecords).toHaveLength(0);
    expect(loggedMessages.some((m) => m.includes("server not found"))).toBe(true);
  });

  it("fails soft with no-auth-block when the stored server has no auth (e.g. headers-only or stdio)", async () => {
    const headersOnly: McpServerDefinition = { name: "headers-only", transport: "sse", url: "https://mcp.example/plain" };
    const { store } = createFakeStore({ project: { mcpServers: { enabled: true, servers: [headersOnly] } } });
    const result = await updateMcpServerOAuthTokens({ serverName: "headers-only", scope: "project", accessToken: "at-1" }, store);
    expect(result).toEqual({ persisted: false, reason: "no-auth-block" });
  });

  it("fails soft with error (never throws) when a downstream write rejects", async () => {
    const { store } = createFakeStore({ project: { mcpServers: { enabled: true, servers: [oauthServer()] } } });
    store.updateSettings = async () => {
      throw new Error("db unavailable");
    };
    const result = await updateMcpServerOAuthTokens({ serverName: "asana", scope: "project", accessToken: "at-1" }, store);
    expect(result).toEqual({ persisted: false, reason: "error" });
  });

  it("never logs token/secret material — only server name, scope, and coarse outcome", async () => {
    const { store, loggedMessages } = createFakeStore({ project: { mcpServers: { enabled: true, servers: [oauthServer()] } } });
    await updateMcpServerOAuthTokens(
      { serverName: "asana", scope: "project", accessToken: "super-secret-access-token", refreshToken: "super-secret-refresh-token" },
      store,
    );
    const serialized = JSON.stringify(loggedMessages);
    expect(serialized).not.toContain("super-secret-access-token");
    expect(serialized).not.toContain("super-secret-refresh-token");
  });
});

describe("saveMcpServerOAuthClientInformation", () => {
  it("persists clientId and clientSecret (DCR client information path)", async () => {
    const { store, secretRecords } = createFakeStore({ project: { mcpServers: { enabled: true, servers: [oauthServer()] } } });

    const result = await saveMcpServerOAuthClientInformation(
      { serverName: "asana", scope: "project", clientId: "dcr-client-1", clientSecret: "dcr-secret-1" },
      store,
    );

    expect(result).toEqual({ persisted: true, fieldsWritten: ["clientId", "clientSecret"] });
    const settings = await store.getSettingsByScope();
    const server = settings.project.mcpServers?.servers?.[0];
    expect(server?.auth).toMatchObject({ clientId: "dcr-client-1" });
    expect((server?.auth as { clientSecret?: unknown })?.clientSecret).toEqual({ secretRef: secretRecords[0]!.id, scope: "project" });
  });

  it("persists clientId only (no clientSecret) without creating a secret", async () => {
    const { store, secretRecords } = createFakeStore({ project: { mcpServers: { enabled: true, servers: [oauthServer()] } } });
    const result = await saveMcpServerOAuthClientInformation({ serverName: "asana", scope: "project", clientId: "dcr-client-1" }, store);
    expect(result).toEqual({ persisted: true, fieldsWritten: ["clientId"] });
    expect(secretRecords).toHaveLength(0);
  });

  it("update-in-place reuses the existing clientSecret secret id (no duplicate)", async () => {
    const { store, secretRecords } = createFakeStore({ project: { mcpServers: { enabled: true, servers: [oauthServer()] } } });
    await saveMcpServerOAuthClientInformation({ serverName: "asana", scope: "project", clientId: "c1", clientSecret: "s1" }, store);
    await saveMcpServerOAuthClientInformation({ serverName: "asana", scope: "project", clientId: "c1", clientSecret: "s2" }, store);
    expect(secretRecords).toHaveLength(1);
    expect(secretRecords[0]!.plaintextValue).toBe("s2");
  });

  it("fails soft with server-not-found (never throws)", async () => {
    const { store } = createFakeStore({ project: { mcpServers: { enabled: true, servers: [] } } });
    const result = await saveMcpServerOAuthClientInformation({ serverName: "gone", scope: "project", clientId: "c1" }, store);
    expect(result).toEqual({ persisted: false, reason: "server-not-found" });
  });

  it("never logs client secret material", async () => {
    const { store, loggedMessages } = createFakeStore({ project: { mcpServers: { enabled: true, servers: [oauthServer()] } } });
    await saveMcpServerOAuthClientInformation({ serverName: "asana", scope: "project", clientId: "c1", clientSecret: "top-secret-client-secret" }, store);
    expect(JSON.stringify(loggedMessages)).not.toContain("top-secret-client-secret");
  });
});
