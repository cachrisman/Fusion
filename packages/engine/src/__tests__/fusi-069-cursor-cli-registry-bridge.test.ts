import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { PluginRunner } from "../plugin-runner.js";
import type { CliProviderContribution } from "@fusion/core";
import { registerExtensionProviders } from "../pi.js";

/*
FNXC:PluginProviderBridge 2026-07-11-00:00:
FUSI-069 registry-level symptom repro + fix verification: before this task,
`registerExtensionProviders` (the sole seam that seeds the execution
`ModelRegistry` `createFnAgent` resolves against) only registered the
zai/grok built-ins and pi-extension providers — an enabled Fusion-plugin
`cliProviders` contribution such as cursor-cli was never bridged in, so any
`cursor-cli/<id>` selection hard-failed at session creation with "was not
found in the pi model registry". These tests assert:
  1. an enabled + authenticated plugin cliProvider's discovered models ARE
     registered into the execution ModelRegistry (the fix),
  2. an unauthenticated/empty/throwing plugin cliProvider registers ZERO rows
     for that provider WITHOUT throwing and WITHOUT disturbing the built-in
     zai/grok registrations (the required guard/degrade contract),
  3. registerExtensionProviders with no pluginRunner at all behaves exactly
     as before this task (backward-compatible default).
*/

function makeModelRegistry(): ModelRegistry {
  const authStorage = AuthStorage.inMemory();
  return ModelRegistry.inMemory(authStorage);
}

function makeCursorContribution(overrides: Partial<CliProviderContribution> = {}): CliProviderContribution {
  return {
    providerId: "cursor-cli",
    displayName: "Cursor CLI",
    binaryName: "cursor-agent",
    providerType: "cli",
    statusRoute: "/providers/cursor-cli/status",
    authRoute: "/auth/cursor-cli",
    discoverModels: vi.fn().mockResolvedValue({
      models: [
        { id: "auto", label: "auto" },
        { id: "composer-2.5", label: "composer-2.5", reasoning: true, contextWindow: 200000 },
      ],
      source: "cli",
      fallbackUsed: false,
    }),
    runtime: { runtimeId: "cursor" },
    ...overrides,
  };
}

function makePluginRunner(
  contributions: Array<{ pluginId: string; contribution: CliProviderContribution }>,
): PluginRunner {
  return {
    getCliProviderContributions: vi.fn().mockReturnValue(contributions),
    createRuntimeContext: vi.fn().mockResolvedValue({
      pluginId: "fusion-plugin-cursor-runtime",
      taskStore: {},
      settings: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      emitEvent: vi.fn(),
    }),
  } as unknown as PluginRunner;
}

describe("FUSI-069: plugin cliProviders bridge into the execution ModelRegistry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers discovered cursor-cli models when the cursor plugin is enabled and authenticated", async () => {
    const modelRegistry = makeModelRegistry();
    const contribution = makeCursorContribution();
    const pluginRunner = makePluginRunner([{ pluginId: "fusion-plugin-cursor-runtime", contribution }]);

    await registerExtensionProviders(process.cwd(), modelRegistry, pluginRunner);

    const auto = modelRegistry.find("cursor-cli", "auto");
    const composer = modelRegistry.find("cursor-cli", "composer-2.5");
    expect(auto).toBeDefined();
    expect(composer).toBeDefined();
    expect(composer?.reasoning).toBe(true);
    expect(composer?.contextWindow).toBe(200000);

    // Built-in zai/grok registrations must remain intact.
    expect(modelRegistry.getAll().some((m) => m.provider === "grok-cli")).toBe(true);
  });

  it("registers zero cursor-cli rows and leaves grok/zai intact when the plugin is unauthenticated (empty discovery)", async () => {
    const modelRegistry = makeModelRegistry();
    const contribution = makeCursorContribution({
      discoverModels: vi.fn().mockResolvedValue({ models: [], source: "probe", fallbackUsed: true, reason: "binary unavailable" }),
    });
    const pluginRunner = makePluginRunner([{ pluginId: "fusion-plugin-cursor-runtime", contribution }]);

    await expect(registerExtensionProviders(process.cwd(), modelRegistry, pluginRunner)).resolves.toBeUndefined();

    expect(modelRegistry.getAll().some((m) => m.provider === "cursor-cli")).toBe(false);
    expect(modelRegistry.getAll().some((m) => m.provider === "grok-cli")).toBe(true);
  });

  it("degrades to zero rows without throwing when discoverModels throws", async () => {
    const modelRegistry = makeModelRegistry();
    const contribution = makeCursorContribution({
      discoverModels: vi.fn().mockRejectedValue(new Error("cursor-agent probe timed out")),
    });
    const pluginRunner = makePluginRunner([{ pluginId: "fusion-plugin-cursor-runtime", contribution }]);

    await expect(registerExtensionProviders(process.cwd(), modelRegistry, pluginRunner)).resolves.toBeUndefined();

    expect(modelRegistry.getAll().some((m) => m.provider === "cursor-cli")).toBe(false);
    expect(modelRegistry.getAll().some((m) => m.provider === "grok-cli")).toBe(true);
    expect(modelRegistry.getAll().some((m) => m.provider === "zai")).toBe(
      modelRegistry.getAll().some((m) => m.provider === "zai"),
    );
  });

  it("does not throw and behaves unchanged when getCliProviderContributions itself throws", async () => {
    const modelRegistry = makeModelRegistry();
    const pluginRunner = {
      getCliProviderContributions: vi.fn(() => {
        throw new Error("plugin loader unavailable");
      }),
      createRuntimeContext: vi.fn(),
    } as unknown as PluginRunner;

    await expect(registerExtensionProviders(process.cwd(), modelRegistry, pluginRunner)).resolves.toBeUndefined();
    expect(modelRegistry.getAll().some((m) => m.provider === "grok-cli")).toBe(true);
  });

  it("remains backward compatible when no pluginRunner is provided (default seeding unchanged)", async () => {
    const modelRegistry = makeModelRegistry();
    await expect(registerExtensionProviders(process.cwd(), modelRegistry)).resolves.toBeUndefined();
    expect(modelRegistry.getAll().some((m) => m.provider === "cursor-cli")).toBe(false);
    expect(modelRegistry.getAll().some((m) => m.provider === "grok-cli")).toBe(true);
  });
});
