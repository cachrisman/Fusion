import { describe, expect, it } from "vitest";
import {
  exportMcpServersJson,
  importMcpServersJson,
  materializeMcpServerSecrets,
  resolveEffectiveMcpServers,
} from "../mcp-config.js";
import {
  validateMcpServerDefinition,
  validateMcpServerDefinitions,
  validateMcpServerDefinitionsDetailed,
} from "../settings-validation.js";
import type { McpServerDefinition } from "../types.js";

const projectSecret = { secretRef: "project-token", scope: "project" as const };
const globalSecret = { secretRef: "global-token", scope: "global" as const };

describe("MCP core config", () => {
  it("resolves project servers over global servers by name", () => {
    const globalServer: McpServerDefinition = {
      name: "github",
      transport: "stdio",
      command: "global-gh",
      env: { TOKEN: globalSecret },
    };
    const projectServer: McpServerDefinition = {
      name: "github",
      transport: "stdio",
      command: "project-gh",
      args: ["serve"],
      env: { TOKEN: projectSecret },
    };

    expect(
      resolveEffectiveMcpServers(
        { mcpServers: { enabled: true, servers: [globalServer] } },
        { mcpServers: { enabled: true, servers: [projectServer] } },
      ),
    ).toEqual([projectServer]);
  });

  it("lets a project disabled entry remove a global server", () => {
    const globalServer: McpServerDefinition = {
      name: "global-only",
      transport: "stdio",
      command: "global-command",
    };
    const disabledProjectOverride: McpServerDefinition = {
      name: "global-only",
      enabled: false,
      transport: "stdio",
      command: "ignored",
    };

    expect(
      resolveEffectiveMcpServers(
        { mcpServers: { enabled: true, servers: [globalServer] } },
        { mcpServers: { enabled: true, servers: [disabledProjectOverride] } },
      ),
    ).toEqual([]);
  });

  it("rejects plaintext sensitive env and header values while accepting secret refs", () => {
    expect(
      validateMcpServerDefinition({
        name: "bad-env",
        transport: "stdio",
        command: "node",
        env: { TOKEN: "plaintext" },
      }),
    ).toBeUndefined();

    expect(
      validateMcpServerDefinition({
        name: "bad-header",
        transport: "sse",
        url: "https://example.test/sse",
        headers: { Authorization: "Bearer plaintext" },
      }),
    ).toBeUndefined();

    expect(
      validateMcpServerDefinition({
        name: "good",
        transport: "sse",
        url: "https://example.test/sse",
        headers: { Authorization: projectSecret },
      }),
    ).toEqual({
      name: "good",
      transport: "sse",
      url: "https://example.test/sse",
      headers: { Authorization: projectSecret },
    });
  });

  it("validates required fields by transport and rejects duplicate names", () => {
    expect(validateMcpServerDefinition({ name: "stdio", transport: "stdio" })).toBeUndefined();
    expect(validateMcpServerDefinition({ name: "sse", transport: "sse" })).toBeUndefined();
    expect(validateMcpServerDefinition({ name: "http", transport: "streamable-http" })).toBeUndefined();

    const duplicateResult = validateMcpServerDefinitionsDetailed([
      { name: "dup", transport: "stdio", command: "one" },
      { name: "dup", transport: "stdio", command: "two" },
    ]);
    expect(duplicateResult.value).toBeUndefined();
    expect(duplicateResult.errors.map((error) => error.code)).toContain("duplicate-name");
    expect(
      validateMcpServerDefinitions([
        { name: "one", transport: "stdio", command: "one" },
        { name: "two", transport: "streamable-http", url: "https://example.test/mcp" },
      ]),
    ).toHaveLength(2);
  });

  it("imports plaintext sensitive values as secret descriptors and round-trips exported refs", () => {
    const imported = importMcpServersJson({
      mcpServers: {
        github: {
          command: "github-mcp-server",
          args: ["stdio"],
          env: { GITHUB_TOKEN: "ghp_secret" },
        },
        docs: {
          transport: "streamable-http",
          url: "https://docs.example.test/mcp",
          headers: { Authorization: globalSecret },
        },
      },
    });

    expect(imported.errors).toEqual([]);
    expect(imported.secretsToCreate).toEqual([
      {
        serverName: "github",
        field: "env",
        key: "GITHUB_TOKEN",
        scope: "project",
        suggestedKey: "mcp.github.env.GITHUB_TOKEN",
        plaintextValue: "ghp_secret",
      },
    ]);
    expect(imported.definitions[0]).toMatchObject({
      name: "github",
      transport: "stdio",
      env: { GITHUB_TOKEN: { secretRef: "mcp.github.env.GITHUB_TOKEN", scope: "project" } },
    });

    const original: McpServerDefinition[] = [
      {
        name: "docs",
        transport: "streamable-http",
        url: "https://docs.example.test/mcp",
        headers: { Authorization: globalSecret },
      },
    ];
    const roundTrip = importMcpServersJson(exportMcpServersJson(original));
    expect(roundTrip.errors).toEqual([]);
    expect(roundTrip.secretsToCreate).toEqual([]);
    expect(roundTrip.definitions).toEqual(original);
  });

  it("materializes secret refs through an injected reader and omits failed refs", async () => {
    const calls: Array<{ id: string; scope: string; userId?: string | null }> = [];
    const server: McpServerDefinition = {
      name: "secure",
      transport: "stdio",
      command: "secure-mcp",
      env: {
        OK: { secretRef: "ok", scope: "project" },
        MISSING: { secretRef: "missing", scope: "global" },
      },
    };

    const resolved = await materializeMcpServerSecrets(
      server,
      {
        async revealSecret(id, scope, reader) {
          calls.push({ id, scope, userId: reader.userId });
          if (id === "missing") throw new Error("not found");
          return { key: id, plaintextValue: "resolved-value" };
        },
      },
      { userId: "tester" },
    );

    expect(calls).toEqual([
      { id: "ok", scope: "project", userId: "tester" },
      { id: "missing", scope: "global", userId: "tester" },
    ]);
    expect(resolved.value).toMatchObject({
      name: "secure",
      transport: "stdio",
      env: { OK: "resolved-value" },
    });
    expect((resolved.value as Extract<typeof resolved.value, { transport: "stdio" }>)?.env).not.toHaveProperty("MISSING");
    expect(resolved.errors).toHaveLength(1);
  });

  describe("oauth auth variant (FUSI-073)", () => {
    it("materializes the oauth token bundle and clientSecret into a resolved plaintext shape", async () => {
      const server: McpServerDefinition = {
        name: "asana",
        transport: "sse",
        url: "https://mcp.asana.test/sse",
        auth: {
          type: "oauth",
          authorizationServerUrl: "https://auth.asana.test",
          clientId: "fusion-client",
          clientSecret: { secretRef: "asana-client-secret", scope: "project" },
          scopes: ["projects:read"],
          redirectUrl: "https://dashboard.example.test/oauth/callback",
          accessToken: { secretRef: "asana-access-token", scope: "project" },
          refreshToken: { secretRef: "asana-refresh-token", scope: "project" },
          expiresAt: 1_800_000_000_000,
        },
      };

      const resolved = await materializeMcpServerSecrets(
        server,
        {
          async revealSecret(id) {
            return { key: id, plaintextValue: `plain-${id}` };
          },
        },
        { userId: "tester" },
      );

      expect(resolved.errors).toEqual([]);
      expect(resolved.value).toMatchObject({
        name: "asana",
        transport: "sse",
        auth: {
          type: "oauth",
          authorizationServerUrl: "https://auth.asana.test",
          clientId: "fusion-client",
          clientSecret: "plain-asana-client-secret",
          scopes: ["projects:read"],
          redirectUrl: "https://dashboard.example.test/oauth/callback",
          accessToken: "plain-asana-access-token",
          refreshToken: "plain-asana-refresh-token",
          expiresAt: 1_800_000_000_000,
        },
      });
    });

    it("reports a missing oauth secret ref and omits the field rather than returning plaintext", async () => {
      const server: McpServerDefinition = {
        name: "linear",
        transport: "streamable-http",
        url: "https://mcp.linear.test/mcp",
        auth: {
          type: "oauth",
          authorizationServerUrl: "https://auth.linear.test",
          accessToken: { secretRef: "missing-access-token", scope: "project" },
        },
      };

      const resolved = await materializeMcpServerSecrets(
        server,
        {
          async revealSecret(id) {
            throw new Error(`not found: ${id}`);
          },
        },
        { userId: "tester" },
      );

      expect(resolved.errors).toEqual([
        expect.objectContaining({
          serverName: "linear",
          path: "auth.accessToken",
          secretRef: { secretRef: "missing-access-token", scope: "project" },
        }),
      ]);
      expect(
        (resolved.value as Extract<typeof resolved.value, { transport: "streamable-http" }>)?.auth,
      ).not.toHaveProperty("accessToken");
    });

    it("leaves the no-auth headers-only shape unaffected", async () => {
      const server: McpServerDefinition = {
        name: "docs",
        transport: "streamable-http",
        url: "https://docs.example.test/mcp",
        headers: { Authorization: globalSecret },
      };
      const resolved = await materializeMcpServerSecrets(
        server,
        { async revealSecret(id) { return { key: id, plaintextValue: "resolved" }; } },
        { userId: "tester" },
      );
      expect(resolved.errors).toEqual([]);
      expect(resolved.value).not.toHaveProperty("auth");
    });

    it("preserves an already-secret-ref oauth block through export\u2192import round-trip", () => {
      const original: McpServerDefinition[] = [
        {
          name: "asana",
          transport: "sse",
          url: "https://mcp.asana.test/sse",
          auth: {
            type: "oauth",
            authorizationServerUrl: "https://auth.asana.test",
            clientId: "fusion-client",
            clientSecret: { secretRef: "asana-client-secret", scope: "project" },
            accessToken: { secretRef: "asana-access-token", scope: "project" },
            refreshToken: { secretRef: "asana-refresh-token", scope: "project" },
            expiresAt: 1_800_000_000_000,
          },
        },
      ];

      const exported = exportMcpServersJson(original);
      expect(exported.mcpServers.asana).toMatchObject({ auth: original[0]!.auth });

      const roundTrip = importMcpServersJson(exported);
      expect(roundTrip.errors).toEqual([]);
      expect(roundTrip.secretsToCreate).toEqual([]);
      expect(roundTrip.definitions).toEqual(original);
    });
  });
});
