import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRunner } from "../plugin-runner.js";
import type { PluginRuntimeRegistration } from "@fusion/core";
import { resolveRuntime } from "../runtime-resolution.js";
import { createResolvedAgentSession, extractRuntimeHint } from "../agent-session-helpers.js";

/*
FNXC:CursorCli 2026-07-11-00:00:
FUSI-069 Step 3: cursor-cli has no HTTP endpoint (unlike grok-cli's xAI
fallback), so a resolvable `cursor-cli/<id>` selection must ALWAYS dispatch to
the real FUSI-063 `CursorRuntimeAdapter` (imported unmodified from the plugin
package, not re-implemented/mocked here) via
extractRuntimeHint -> resolveRuntime -> resolvePluginRuntime -> plugin
factory, never pi's direct HTTP stream path. Binary-free: no live
`cursor-agent` process, mirrors grok-runtime-routing.test.ts's pattern.
*/

const mockCreateFnAgent = vi.hoisted(() => vi.fn());

vi.mock("../logger.js", () => ({
  createLogger: vi.fn(() => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock("../pi.js", () => ({
  createFnAgent: mockCreateFnAgent,
  promptWithFallback: vi.fn().mockResolvedValue(undefined),
  describeModel: vi.fn().mockReturnValue("pi/default"),
}));

function cursorRuntimeAdapterModulePath(): string {
  return fileURLToPath(
    new URL("../../../../plugins/fusion-plugin-cursor-runtime/src/runtime-adapter.ts", import.meta.url),
  );
}

function cursorProbeModulePath(): string {
  return fileURLToPath(
    new URL("../../../../plugins/fusion-plugin-cursor-runtime/src/probe.ts", import.meta.url),
  );
}

type CursorRuntimeAdapterCtor = new () => {
  id: string;
  name: string;
  createSession: (options?: unknown) => Promise<{ session: unknown; sessionFile?: string }>;
  promptWithFallback: (session: unknown, prompt: string, options?: unknown) => Promise<void>;
  describeModel: (session: { model?: string }) => string;
};

/*
FNXC:CursorCli 2026-07-11-00:00:
FUSI-069: this routing test only asserts DISPATCH (does a cursor-cli
selection reach the real CursorRuntimeAdapter, never pi's HTTP path) — it is
not meant to depend on whether THIS machine has an authenticated cursor-agent
CLI installed. The integration branch's real FUSI-063 `createSession` now
probes live auth state via `probeCursorBinary()` before returning a session,
so `vi.doMock` the probe module (matched by resolved absolute path, since the
adapter is loaded via a real dynamic import rather than a mocked specifier)
to a deterministic authenticated result before each dynamic import.
*/
async function loadCursorRuntimeAdapter(): Promise<CursorRuntimeAdapterCtor> {
  vi.doMock(cursorProbeModulePath(), () => ({
    probeCursorBinary: vi.fn().mockResolvedValue({
      available: true,
      authenticated: true,
      binaryName: "cursor-agent",
      binaryPath: "cursor-agent",
      probeDurationMs: 1,
    }),
  }));
  const mod = (await import(pathToFileURL(cursorRuntimeAdapterModulePath()).href)) as {
    CursorRuntimeAdapter: CursorRuntimeAdapterCtor;
  };
  return mod.CursorRuntimeAdapter;
}

function createMockPluginRunner(overrides: Partial<PluginRunner> = {}): PluginRunner {
  return {
    getPluginRuntimes: vi.fn().mockReturnValue([]),
    getRuntimeById: vi.fn().mockReturnValue(undefined),
    createRuntimeContext: vi.fn().mockResolvedValue({
      pluginId: "fusion-plugin-cursor-runtime",
      taskStore: {},
      settings: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      emitEvent: vi.fn(),
    }),
    ...overrides,
  } as unknown as PluginRunner;
}

async function createCursorRegistration(): Promise<{ pluginId: string; runtime: PluginRuntimeRegistration }> {
  const CursorRuntimeAdapter = await loadCursorRuntimeAdapter();
  return {
    pluginId: "fusion-plugin-cursor-runtime",
    runtime: {
      metadata: {
        runtimeId: "cursor",
        name: "Cursor Runtime",
        description: "Cursor CLI runtime support for Fusion",
        version: "0.1.0",
      },
      factory: vi.fn().mockImplementation(async () => new CursorRuntimeAdapter()),
    },
  };
}

describe("Cursor CLI runtime routing (FUSI-069)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateFnAgent.mockResolvedValue({
      session: { runtime: "pi", prompt: vi.fn() },
      sessionFile: "/tmp/pi.session.json",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves the real CursorRuntimeAdapter via resolveRuntime when runtimeHint is 'cursor'", async () => {
    const cursorRegistration = await createCursorRegistration();
    const pluginRunner = createMockPluginRunner({
      getRuntimeById: vi.fn().mockReturnValue(cursorRegistration),
    });

    const resolved = await resolveRuntime({
      sessionPurpose: "executor",
      runtimeHint: "cursor",
      pluginRunner,
    });

    expect(resolved.runtimeId).toBe("cursor");
    expect(resolved.wasConfigured).toBe(true);
    expect(resolved.runtime.id).toBe("cursor");
    expect(resolved.runtime.name).toBe("Cursor Runtime");
    expect(pluginRunner.getRuntimeById).toHaveBeenCalledWith("cursor");
  });

  it("auto-routes a cursor-cli model selection to the cursor runtime (not the pi HTTP path)", async () => {
    const cursorRegistration = await createCursorRegistration();
    const pluginRunner = createMockPluginRunner({
      getRuntimeById: vi.fn().mockReturnValue(cursorRegistration),
    });
    const audit = { database: vi.fn().mockResolvedValue(undefined) };

    const runtimeHint = extractRuntimeHint({ model: "cursor-cli/auto" });
    expect(runtimeHint).toBeUndefined();

    const result = await createResolvedAgentSession({
      sessionPurpose: "executor",
      runtimeHint,
      pluginRunner,
      runAuditor: audit as never,
      cwd: "/tmp/project",
      defaultProvider: "cursor-cli",
      defaultModelId: "auto",
      systemPrompt: "cursor-cli end-to-end routing",
    });

    expect(result.runtimeId).toBe("cursor");
    expect(result.wasConfigured).toBe(true);
    expect(mockCreateFnAgent).not.toHaveBeenCalled();
    expect(result.session).toMatchObject({ model: "auto" });
    expect(audit.database).toHaveBeenCalledWith(expect.objectContaining({
      type: "session:runtime-resolved",
      target: "cursor",
      metadata: expect.objectContaining({
        runtimeHint: "cursor",
        reason: "cursor-cli-plugin-runtime-required",
        provider: "cursor-cli",
        modelId: "auto",
      }),
    }));
  });

  it("auto-routes a cursor-cli fallback model to the cursor runtime", async () => {
    const cursorRegistration = await createCursorRegistration();
    const pluginRunner = createMockPluginRunner({
      getRuntimeById: vi.fn().mockReturnValue(cursorRegistration),
    });

    const result = await createResolvedAgentSession({
      sessionPurpose: "executor",
      pluginRunner,
      cwd: "/tmp/project",
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
      fallbackProvider: "cursor-cli",
      fallbackModelId: "composer-2.5",
      systemPrompt: "cursor-cli fallback routing",
    });

    expect(result.runtimeId).toBe("cursor");
    expect(mockCreateFnAgent).not.toHaveBeenCalled();
  });

  it("surfaces an actionable error instead of falling through to pi's HTTP path when the Cursor runtime is unavailable", async () => {
    const pluginRunner = createMockPluginRunner({
      getRuntimeById: vi.fn().mockReturnValue(undefined),
    });

    await expect(createResolvedAgentSession({
      sessionPurpose: "executor",
      pluginRunner,
      cwd: "/tmp/project",
      defaultProvider: "cursor-cli",
      defaultModelId: "auto",
      systemPrompt: "no-runtime-registered",
    })).rejects.toThrow(/Install and enable the Cursor Runtime plugin/);

    expect(mockCreateFnAgent).not.toHaveBeenCalled();
  });

  it("does not route through cursor when runtimeHint/provider are unrelated (non-cursor agent unaffected)", async () => {
    const pluginRunner = createMockPluginRunner();

    const result = await createResolvedAgentSession({
      sessionPurpose: "executor",
      pluginRunner,
      cwd: "/tmp/project",
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
      systemPrompt: "unrelated agent",
    });

    expect(result.runtimeId).toBe("pi");
    expect(mockCreateFnAgent).toHaveBeenCalledWith(expect.objectContaining({
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
    }));
  });

  it("honors an explicit runtime hint over cursor-cli auto-derivation", async () => {
    const pluginRunner = createMockPluginRunner({
      getRuntimeById: vi.fn().mockReturnValue(undefined),
    });

    const result = await createResolvedAgentSession({
      sessionPurpose: "executor",
      runtimeHint: "pi",
      pluginRunner,
      cwd: "/tmp/project",
      defaultProvider: "cursor-cli",
      defaultModelId: "auto",
      systemPrompt: "explicit pi hint wins",
    });

    expect(result.runtimeId).toBe("pi");
    expect(mockCreateFnAgent).toHaveBeenCalled();
  });
});
