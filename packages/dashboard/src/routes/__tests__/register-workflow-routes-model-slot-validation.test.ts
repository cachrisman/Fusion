// @vitest-environment node

/*
 * FNXC:ModelSlotValidation 2026-07-11-00:00:
 * FUSI-050 Fix #1 symptom verification for the workflow-settings save path:
 * U4 moved execution/planning/validator model lanes (and their fallbacks) OUT
 * of project settings and into per-(workflow, project) workflow setting
 * VALUES (see packages/core/src/moved-settings.ts), so
 * `PATCH /workflows/:id/setting-values` is now the ONLY save path for those
 * lanes and must run the same save-time model-slot validation as the project
 * and global settings routes.
 */
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerWorkflowRoutes } from "../register-workflow-routes.js";
import { request as performRequest } from "../../test-request.js";

const { buildExecutionModelRegistryMock, resolveWorkflowIrByIdMock } = vi.hoisted(() => ({
  buildExecutionModelRegistryMock: vi.fn(),
  resolveWorkflowIrByIdMock: vi.fn(),
}));

vi.mock("@fusion/engine", async () => {
  const actual = await vi.importActual<typeof import("@fusion/engine")>("@fusion/engine");
  return {
    ...actual,
    buildExecutionModelRegistry: buildExecutionModelRegistryMock,
  };
});

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    resolveWorkflowIrById: resolveWorkflowIrByIdMock,
  };
});

function fakeRegistry(entries: Array<{ provider: string; id: string }>) {
  return {
    find: (provider: string, modelId: string) => entries.find((e) => e.provider === provider && e.id === modelId),
    getAll: () => entries,
  };
}

// A v2 IR whose declared settings include one workflow-declared model-lane pair
// (mirrors BUILTIN_WORKFLOW_SETTINGS's executionProvider/executionModelId).
const modelLaneIr = {
  version: "v2" as const,
  name: "wf",
  columns: [],
  nodes: [{ id: "start", kind: "start" }, { id: "end", kind: "end" }],
  edges: [{ from: "start", to: "end", condition: "success" }],
  settings: [
    { id: "executionProvider", name: "Execution provider", type: "string" },
    { id: "executionModelId", name: "Execution model", type: "string" },
  ],
};

function createApp() {
  const router = express.Router();
  let storedValues: Record<string, unknown> = {};

  const store = {
    getWorkflowSettingsProjectId: vi.fn(() => "p1"),
    getWorkflowSettingValues: vi.fn(() => storedValues),
    updateWorkflowSettingValuesWithPrevious: vi.fn(async (_wf: string, _proj: string, patch: Record<string, unknown>) => {
      const previous = { ...storedValues };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete storedValues[key];
        else storedValues[key] = value;
      }
      return { previous, stored: { ...storedValues } };
    }),
    getDefaultWorkflowId: vi.fn(async () => "builtin:coding"),
    getModelLaneDrift: vi.fn(() => []),
    getRootDir: vi.fn(() => "/tmp/project"),
    getWorkflowDefinition: vi.fn(async () => undefined),
  };

  registerWorkflowRoutes({
    router,
    options: {},
    store: store as never,
    runtimeLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
    getProjectContext: vi.fn(async () => ({ store, projectId: "p1" })) as never,
    rethrowAsApiError: (err: unknown) => {
      throw err;
    },
  } as never);

  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? String(err) });
  });

  return { app, store };
}

async function patchSettingValues(app: express.Express, workflowId: string, values: unknown) {
  const res = await performRequest(
    app,
    "PATCH",
    `/api/workflows/${encodeURIComponent(workflowId)}/setting-values`,
    JSON.stringify({ values }),
    { "Content-Type": "application/json" },
  );
  return { status: res.status, body: res.body };
}

describe("register-workflow-routes model-slot save-time validation (setting-values)", () => {
  beforeEach(() => {
    buildExecutionModelRegistryMock.mockReset();
    resolveWorkflowIrByIdMock.mockReset();
    resolveWorkflowIrByIdMock.mockResolvedValue(modelLaneIr);
  });

  it("rejects a workflow-declared model-lane slot absent from the execution registry", async () => {
    buildExecutionModelRegistryMock.mockResolvedValue(fakeRegistry([{ provider: "anthropic", id: "claude-sonnet-4-5" }]));
    const { app, store } = createApp();

    const res = await patchSettingValues(app, "builtin:coding", {
      executionProvider: "zai",
      executionModelId: "glm-5.1",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("zai/glm-5.1");
    expect(store.updateWorkflowSettingValuesWithPrevious).not.toHaveBeenCalled();
  });

  it("warns (does not block) a plugin-gated-not-enabled workflow model-lane slot", async () => {
    buildExecutionModelRegistryMock.mockResolvedValue(fakeRegistry([]));
    const { app, store } = createApp();

    const res = await patchSettingValues(app, "builtin:coding", {
      executionProvider: "grok-cli",
      executionModelId: "grok-4.5",
    });

    expect(res.status).toBe(200);
    expect(store.updateWorkflowSettingValuesWithPrevious).toHaveBeenCalledTimes(1);
    expect(res.body.modelSlotWarnings).toEqual([expect.stringContaining("grok-cli")]);
  });

  it("accepts a workflow model-lane slot that resolves in the execution registry", async () => {
    buildExecutionModelRegistryMock.mockResolvedValue(fakeRegistry([{ provider: "anthropic", id: "claude-sonnet-4-5" }]));
    const { app, store } = createApp();

    const res = await patchSettingValues(app, "builtin:coding", {
      executionProvider: "anthropic",
      executionModelId: "claude-sonnet-4-5",
    });

    expect(res.status).toBe(200);
    expect(store.updateWorkflowSettingValuesWithPrevious).toHaveBeenCalledTimes(1);
    expect(res.body.modelSlotWarnings).toBeUndefined();
  });

  it("never builds the execution registry for non-model-lane settings values", async () => {
    const { app, store } = createApp();

    const res = await patchSettingValues(app, "builtin:coding", { workflowStepTimeoutMs: 123_456 });

    expect(res.status).toBe(200);
    expect(buildExecutionModelRegistryMock).not.toHaveBeenCalled();
    expect(store.updateWorkflowSettingValuesWithPrevious).toHaveBeenCalledTimes(1);
  });
});
