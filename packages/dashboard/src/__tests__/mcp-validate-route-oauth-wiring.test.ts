// @vitest-environment node

/**
 * FNXC:McpConfig 2026-07-12-01:00:
 * FUSI-077: focused confirmation that the `/mcp/validate` route forwards `mcpSettingsStore` + `scope` into
 * `validateMcpServer` (the FUSI-076 seam) for a project-scoped OAuth server lookup, so a proactive refresh
 * performed by the validation probe persists via the settings-backed McpOAuthTokenStore instead of the
 * warn-only in-memory default. Broader coverage (ad-hoc definitions, error paths, malformed bodies) already
 * lives in `mcp-validate-route.test.ts`'s "FUSI-076 remediation" cases; this file exists to satisfy FUSI-077's
 * own Surface Enumeration checklist item for the validation probe path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createApiRoutes } from "../routes.js";
import { request } from "../test-request.js";

const engineMocks = vi.hoisted(() => ({
  validateMcpServer: vi.fn(),
  resolveMcpServersForRuntime: vi.fn(),
  resolveMcpServersForStore: vi.fn(),
}));

vi.mock("@fusion/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/engine")>();
  return {
    ...actual,
    createFnAgent: vi.fn(),
    getExemptToolNames: vi.fn(() => []),
    promptWithFallback: vi.fn(),
    reloadExemptTools: vi.fn(),
    resolveIntegrationBranch: vi.fn(() => "main"),
    resolveMcpServersForRuntime: engineMocks.resolveMcpServersForRuntime,
    resolveMcpServersForStore: engineMocks.resolveMcpServersForStore,
    validateMcpServer: engineMocks.validateMcpServer,
  };
});

function createMockStore() {
  return {
    getRootDir: () => "/workspace",
    getSecretsStore: () => ({ revealSecret: vi.fn() }),
    getSettingsByScope: async () => ({ global: { mcpServers: { enabled: true, servers: [] } }, project: {} }),
  };
}

function createApp(store = createMockStore()) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store as never));
  return app;
}

describe("FUSI-077: POST /api/mcp/validate forwards mcpSettingsStore + scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    engineMocks.validateMcpServer.mockResolvedValue({ status: "valid", message: "ok" });
  });

  it("forwards the scoped store and project owning scope for a stored OAuth server lookup", async () => {
    const store = createMockStore();
    engineMocks.resolveMcpServersForStore.mockResolvedValue({
      servers: [{ name: "docs-oauth", transport: "streamable-http", url: "https://mcp.example.test/stream" }],
      errors: [],
      scopeByServerName: { "docs-oauth": "project" },
    });

    const app = createApp(store);
    const response = await request(
      app,
      "POST",
      "/api/mcp/validate",
      JSON.stringify({ name: "docs-oauth" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect(engineMocks.validateMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ name: "docs-oauth" }),
      expect.objectContaining({ mcpSettingsStore: store, scope: "project" }),
    );
  });
});
