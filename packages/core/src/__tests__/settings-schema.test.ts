import { describe, expect, it } from "vitest";
import { sanitizeMcpServers } from "../settings-schema.js";

describe("settings-schema — MCP oauth auth sanitize (FUSI-073)", () => {
  it("preserves the no-auth headers-only path unchanged", () => {
    const sanitized = sanitizeMcpServers({
      enabled: true,
      servers: [
        {
          name: "docs",
          transport: "streamable-http",
          url: "https://docs.example.test/mcp",
          headers: { Authorization: { secretRef: "docs-token", scope: "project" } },
        },
      ],
    });
    expect(sanitized.servers).toEqual([
      {
        name: "docs",
        transport: "streamable-http",
        url: "https://docs.example.test/mcp",
        headers: { Authorization: { secretRef: "docs-token", scope: "project" } },
      },
    ]);
  });

  it("preserves a valid oauth auth variant, keeping credential fields as secret refs only", () => {
    const sanitized = sanitizeMcpServers({
      enabled: true,
      servers: [
        {
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
        },
      ],
    });
    expect(sanitized.servers).toEqual([
      {
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
      },
    ]);
  });

  it("preserves an oauth block with no clientId and no token bundle (pre-authorize/DCR-later state)", () => {
    const sanitized = sanitizeMcpServers({
      enabled: true,
      servers: [
        {
          name: "linear",
          transport: "streamable-http",
          url: "https://mcp.linear.test/mcp",
          auth: { type: "oauth", authorizationServerUrl: "https://auth.linear.test" },
        },
      ],
    });
    expect(sanitized.servers).toEqual([
      {
        name: "linear",
        transport: "streamable-http",
        url: "https://mcp.linear.test/mcp",
        auth: { type: "oauth", authorizationServerUrl: "https://auth.linear.test" },
      },
    ]);
  });

  it("drops inline plaintext credential fields — never persists them as plaintext", () => {
    const sanitized = sanitizeMcpServers({
      enabled: true,
      servers: [
        {
          name: "bad-token",
          transport: "sse",
          url: "https://mcp.bad.test/sse",
          auth: {
            type: "oauth",
            authorizationServerUrl: "https://auth.bad.test",
            accessToken: "plaintext-access-token",
            clientSecret: "plaintext-client-secret",
          },
        },
      ],
    });
    expect(sanitized.servers).toHaveLength(1);
    const server = sanitized.servers[0]!;
    expect(server).toHaveProperty("auth");
    const auth = (server as { auth?: Record<string, unknown> }).auth;
    expect(auth).not.toHaveProperty("accessToken");
    expect(auth).not.toHaveProperty("clientSecret");
    // Redaction-property assertion: no plaintext secret string ever appears anywhere in the sanitized output.
    expect(JSON.stringify(sanitized)).not.toContain("plaintext-access-token");
    expect(JSON.stringify(sanitized)).not.toContain("plaintext-client-secret");
  });

  it("drops a malformed auth block (missing authorizationServerUrl) while keeping the server and its sibling", () => {
    const sanitized = sanitizeMcpServers({
      enabled: true,
      servers: [
        {
          name: "malformed-auth",
          transport: "sse",
          url: "https://mcp.bad.test/sse",
          auth: { type: "oauth" },
        },
        {
          name: "healthy-sibling",
          transport: "stdio",
          command: "node",
        },
      ],
    });
    expect(sanitized.servers).toHaveLength(2);
    const malformed = sanitized.servers.find((server) => server.name === "malformed-auth");
    expect(malformed).not.toHaveProperty("auth");
    const sibling = sanitized.servers.find((server) => server.name === "healthy-sibling");
    expect(sibling).toBeDefined();
  });

  it("redaction property: a sanitized oauth definition contains no plaintext secret values, only { secretRef, scope } objects", () => {
    const sanitized = sanitizeMcpServers({
      enabled: true,
      servers: [
        {
          name: "slack",
          transport: "streamable-http",
          url: "https://mcp.slack.test/mcp",
          auth: {
            type: "oauth",
            authorizationServerUrl: "https://auth.slack.test",
            clientSecret: { secretRef: "slack-client-secret", scope: "global" },
            accessToken: { secretRef: "slack-access-token", scope: "global" },
            refreshToken: { secretRef: "slack-refresh-token", scope: "global" },
          },
        },
      ],
    });
    const auth = (sanitized.servers[0] as { auth?: Record<string, unknown> }).auth!;
    for (const field of ["clientSecret", "accessToken", "refreshToken"] as const) {
      const value = auth[field] as { secretRef?: unknown; scope?: unknown };
      expect(typeof value).toBe("object");
      expect(typeof value.secretRef).toBe("string");
      expect(value.scope === "project" || value.scope === "global").toBe(true);
    }
  });
});
