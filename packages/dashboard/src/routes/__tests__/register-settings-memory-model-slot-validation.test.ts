// @vitest-environment node

/*
 * FNXC:ModelSlotValidation 2026-07-11-00:00:
 * FUSI-050 Fix #1 symptom verification (dashboard save routes): submit a
 * project/global settings save whose slot points at a provider/model absent
 * from the execution ModelRegistry. Before the fix nothing rejected or warned
 * at save time; after the fix an unresolvable slot is rejected (400) and a
 * plugin-gated-not-enabled slot (cursor-cli, grok-cli) warns instead of
 * blocking, but is never silent.
 */
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSettingsMemoryRoutes } from "../register-settings-memory-routes.js";
import { request as performRequest } from "../../test-request.js";

const { buildExecutionModelRegistryMock } = vi.hoisted(() => ({
  buildExecutionModelRegistryMock: vi.fn(),
}));

vi.mock("@fusion/engine", async () => {
  const actual = await vi.importActual<typeof import("@fusion/engine")>("@fusion/engine");
  return {
    ...actual,
    buildExecutionModelRegistry: buildExecutionModelRegistryMock,
  };
});

function fakeRegistry(entries: Array<{ provider: string; id: string }>) {
  return {
    find: (provider: string, modelId: string) => entries.find((e) => e.provider === provider && e.id === modelId),
    getAll: () => entries,
  };
}

function createApp() {
  const router = express.Router();
  const scopedStore = {
    getSettings: vi.fn(async () => ({})),
    getRootDir: vi.fn(() => "/tmp/project"),
    getFusionDir: vi.fn(() => "/tmp/project/.fusion"),
    updateSettings: vi.fn(async (patch: Record<string, unknown>) => patch),
  };
  const globalStore = {
    getRootDir: vi.fn(() => "/tmp/project"),
    getGlobalSettingsStore: vi.fn(() => ({ getSettings: vi.fn(async () => ({})) })),
    updateGlobalSettings: vi.fn(async (patch: Record<string, unknown>) => patch),
  };

  registerSettingsMemoryRoutes(
    {
      router,
      options: {},
      store: globalStore as any,
      runtimeLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any,
      getProjectContext: vi.fn(async () => ({ store: scopedStore, projectId: "p1" })),
      rethrowAsApiError: (err: unknown) => {
        throw err;
      },
    },
    {
      githubToken: undefined,
      validateModelPresets: vi.fn(() => undefined),
      sanitizeOverlapIgnorePaths: vi.fn(() => undefined),
      discoverDashboardPiExtensions: vi.fn(async () => ({ manifestPaths: [], disabledIds: [] })),
    },
  );

  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? String(err) });
  });

  return { app, scopedStore, globalStore };
}

async function putSettings(app: express.Express, body: unknown) {
  const res = await performRequest(app, "PUT", "/api/settings", JSON.stringify(body), {
    "Content-Type": "application/json",
  });
  return { status: res.status, body: res.body };
}

async function putGlobalSettings(app: express.Express, body: unknown) {
  const res = await performRequest(app, "PUT", "/api/settings/global", JSON.stringify(body), {
    "Content-Type": "application/json",
  });
  return { status: res.status, body: res.body };
}

describe("register-settings-memory-routes model-slot save-time validation", () => {
  beforeEach(() => {
    buildExecutionModelRegistryMock.mockReset();
  });

  it("rejects a project-scope slot pointing at a provider/model absent from the execution registry", async () => {
    buildExecutionModelRegistryMock.mockResolvedValue(fakeRegistry([{ provider: "anthropic", id: "claude-sonnet-4-5" }]));
    const { app, scopedStore } = createApp();

    const res = await putSettings(app, {
      titleSummarizerProvider: "zai",
      titleSummarizerModelId: "glm-5.1",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("zai/glm-5.1");
    expect(scopedStore.updateSettings).not.toHaveBeenCalled();
  });

  it("warns (does not block) a project-scope plugin-gated-not-enabled slot and returns the warning", async () => {
    buildExecutionModelRegistryMock.mockResolvedValue(fakeRegistry([]));
    const { app, scopedStore } = createApp();

    const res = await putSettings(app, {
      titleSummarizerFallbackProvider: "cursor-cli",
      titleSummarizerFallbackModelId: "gpt-5.3-codex-high",
    });

    expect(res.status).toBe(200);
    expect(scopedStore.updateSettings).toHaveBeenCalledTimes(1);
    expect(res.body.modelSlotWarnings).toEqual([
      expect.stringContaining("cursor-cli"),
    ]);
  });

  it("accepts a project-scope slot that resolves in the execution registry", async () => {
    buildExecutionModelRegistryMock.mockResolvedValue(fakeRegistry([{ provider: "anthropic", id: "claude-sonnet-4-5" }]));
    const { app, scopedStore } = createApp();

    const res = await putSettings(app, {
      titleSummarizerProvider: "anthropic",
      titleSummarizerModelId: "claude-sonnet-4-5",
    });

    expect(res.status).toBe(200);
    expect(scopedStore.updateSettings).toHaveBeenCalledTimes(1);
    expect(res.body.modelSlotWarnings).toBeUndefined();
  });

  it("never validates when no model-slot fields are present in the payload (empty-slot no-op)", async () => {
    const { app, scopedStore } = createApp();

    const res = await putSettings(app, { autoMerge: true });

    expect(res.status).toBe(200);
    expect(buildExecutionModelRegistryMock).not.toHaveBeenCalled();
    expect(scopedStore.updateSettings).toHaveBeenCalledTimes(1);
  });

  it("rejects a global-scope fallback slot pointing at a provider/model absent from the execution registry", async () => {
    buildExecutionModelRegistryMock.mockResolvedValue(fakeRegistry([{ provider: "anthropic", id: "claude-sonnet-4-5" }]));
    const { app, globalStore } = createApp();

    const res = await putGlobalSettings(app, {
      fallbackProvider: "openai-codex",
      fallbackModelId: "missing-model",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("openai-codex/missing-model");
    expect(globalStore.updateGlobalSettings).not.toHaveBeenCalled();
  });

  it("accepts a global-scope slot that resolves in the execution registry", async () => {
    buildExecutionModelRegistryMock.mockResolvedValue(fakeRegistry([{ provider: "anthropic", id: "claude-sonnet-4-5" }]));
    const { app, globalStore } = createApp();

    const res = await putGlobalSettings(app, {
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
    });

    expect(res.status).toBe(200);
    expect(globalStore.updateGlobalSettings).toHaveBeenCalledTimes(1);
  });
});
