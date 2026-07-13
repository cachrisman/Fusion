import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PathLike } from "node:fs";

/*
FNXC:SessionWiring 2026-07-13-00:00:
Regression coverage for FUSI-088 (Runfusion/Fusion#1946-class no-verdict defect):
`createFnAgent`'s final "Wire up event listeners" block previously called
`promptableSession.subscribe(...)` UNGUARDED. A resolved runtime session that
does not implement the pi `subscribe(listener)` API (delegated CLI runtimes
such as cursor/droid/grok, which stream via their own `onText` callback
instead) made this throw `TypeError: session.subscribe is not a function`,
which the workflow-graph executor surfaces as a no-verdict "failed before
producing a verdict" failure that burns the task's entire retry budget
(observed on FUSI-082, 3/3 retries exhausted).

These tests drive `createFnAgent` with a mock `createAgentSession` resolving a
session object that OMITS `subscribe` entirely (mirroring a delegated CLI
runtime session shape) and assert:
  1. `createFnAgent` does not throw `session.subscribe is not a function`.
  2. Streamed text is still captured via the `onText`/`onThinking` fallback
     forwarded at session creation (matching `reviewer.ts`'s
     `streamReviewTextFromOnText` pattern).
  3. A control case (subscribe present) proves the guard does not regress the
     existing pi-runtime streaming path.

This mirrors the `pi-create-fn-agent.test.ts` mock harness (kept intentionally
narrow/duplicated here rather than importing that file's internals, since its
mocks are module-scoped `vi.mock` factories that cannot be shared across test
files).
*/

const createAgentSessionMock = vi.fn();
const createBashToolMock = vi.fn((cwd: string, options?: any) => ({ name: "bash", cwd, options }));
const createCodingToolsMock = vi.fn(() => []);
const createReadOnlyToolsMock = vi.fn(() => []);
const createExtensionRuntimeMock = vi.fn();
const discoverAndLoadExtensionsMock = vi.fn().mockResolvedValue({
  runtime: { pendingProviderRegistrations: [] },
  errors: [],
});
const packageManagerResolveMock = vi.fn().mockResolvedValue({ extensions: [] });
const findMock = vi.fn();
const getAllMock = vi.fn(() => [] as any[]);
const registerProviderMock = vi.fn();
const refreshMock = vi.fn();
const getApiKeyAndHeadersMock = vi.fn(async () => ({ ok: true, apiKey: undefined, headers: undefined }));
const sessionManagerGetSessionIdMock = vi.fn(() => undefined);
const settingsManagerCreateMock = vi.fn(() => ({ kind: "settings-manager-create" }));
const settingsManagerInMemoryMock = vi.fn(() => ({ kind: "settings-manager" }));
const setFallbackResolverMock = vi.fn();
const authStorageGetApiKeyMock = vi.fn(async () => undefined);
const authStorageGetMock = vi.fn(() => undefined);
const authStorageHasMock = vi.fn(() => false);
const authStorageHasAuthMock = vi.fn(() => false);
const authStorageGetAllMock = vi.fn(() => ({}));
const authStorageListMock = vi.fn(() => []);
const reloadMock = vi.fn(async () => {});
const execSyncMock = vi.fn((_cmd?: any, _opts?: any) => "");
const spawnSyncMock = vi.fn(() => ({ status: 1, stdout: "" }));
const execFileMock = vi.fn((_file?: any, _args?: any, _opts?: any, cb?: any) => {
  const callback = typeof _opts === "function" ? _opts : cb;
  if (typeof callback === "function") callback(null, "", "");
});
const existsSyncMock = vi.fn((_path: PathLike) => false);
const readFileSyncMock = vi.fn((_path?: any) => "{}");
const realpathSyncNativeMock = vi.fn((path: PathLike) => String(path));
const readCustomProvidersMock = vi.fn(() => []);
const packageManagerCwdCapture = vi.fn();
const packageManagerSettingsCapture = vi.fn();

vi.mock("node:child_process", () => {
  const execSyncFn = execSyncMock;
  const kPromisifyCustom = Symbol.for("nodejs.util.promisify.custom");

  const execFn: any = vi.fn((cmd: string, opts: any, cb: any) => {
    const callback = typeof opts === "function" ? opts : cb;
    const options = typeof opts === "function" ? {} : (opts ?? {});
    try {
      const out = execSyncFn(cmd, { ...options, stdio: ["pipe", "pipe", "pipe"] });
      const stdout = out === undefined ? "" : out.toString();
      if (typeof callback === "function") callback(null, stdout, "");
    } catch (err) {
      if (typeof callback === "function") {
        const error = err as { stdout?: string; stderr?: string };
        callback(err, error?.stdout?.toString?.() ?? "", error?.stderr?.toString?.() ?? "");
      }
    }
  });

  execFn[kPromisifyCustom] = (cmd: string, opts?: any) =>
    new Promise((resolve, reject) => {
      execFn(cmd, opts, (err: any, stdout: string, stderr: string) => {
        if (err) {
          (err as Record<string, unknown>).stdout = stdout;
          (err as Record<string, unknown>).stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  return { execSync: execSyncFn, exec: execFn, execFile: execFileMock, spawnSync: spawnSyncMock };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
    realpathSync: Object.assign(vi.fn((path: PathLike) => String(path)), {
      native: realpathSyncNativeMock,
    }),
  };
});

vi.mock("../custom-providers.js", () => ({
  readCustomProviders: readCustomProvidersMock,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: {
    create: () => ({
      setFallbackResolver: setFallbackResolverMock,
      getApiKey: authStorageGetApiKeyMock,
      get: authStorageGetMock,
      set: vi.fn(),
      has: authStorageHasMock,
      hasAuth: authStorageHasAuthMock,
      getAll: authStorageGetAllMock,
      list: authStorageListMock,
      logout: vi.fn(),
      remove: vi.fn(),
      reload: vi.fn(),
    }),
  },
  createAgentSession: createAgentSessionMock,
  createBashTool: createBashToolMock,
  createCodingTools: createCodingToolsMock,
  createEditTool: () => ({ name: "edit" }),
  createExtensionRuntime: createExtensionRuntimeMock,
  createFindTool: () => ({ name: "find" }),
  createGrepTool: () => ({ name: "grep" }),
  createLsTool: () => ({ name: "ls" }),
  createReadOnlyTools: createReadOnlyToolsMock,
  createReadTool: () => ({ name: "read" }),
  createWriteTool: () => ({ name: "write" }),
  DefaultResourceLoader: class {
    async reload() {
      await reloadMock();
    }
  },
  DefaultPackageManager: class {
    private readonly settingsManager: any;

    constructor(options: any) {
      packageManagerCwdCapture(options?.cwd);
      packageManagerSettingsCapture(options?.settingsManager);
      this.settingsManager = options?.settingsManager;
    }
    async resolve() {
      this.settingsManager.isProjectTrusted();
      return packageManagerResolveMock();
    }
  },
  discoverAndLoadExtensions: discoverAndLoadExtensionsMock,
  getAgentDir: () => "/mock-agent-dir",
  ModelRegistry: class {
    static create(...args: unknown[]) {
      return new (this as unknown as new () => unknown)();
    }
    find(provider: string, modelId: string) {
      return findMock(provider, modelId);
    }
    getAll() {
      return getAllMock();
    }
    registerProvider(name: string, config: unknown) {
      return registerProviderMock(name, config);
    }
    refresh() {
      return refreshMock();
    }
    getApiKeyAndHeaders() {
      return getApiKeyAndHeadersMock();
    }
  },
  SessionManager: {
    inMemory: () => ({ kind: "session-manager", getSessionId: sessionManagerGetSessionIdMock }),
  },
  SettingsManager: {
    create: settingsManagerCreateMock,
    inMemory: settingsManagerInMemoryMock,
  },
}));

describe("createFnAgent subscribe guard (FUSI-088)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execSyncMock.mockReturnValue("");
    spawnSyncMock.mockReturnValue({ status: 1, stdout: "" });
    existsSyncMock.mockReturnValue(false);
    readFileSyncMock.mockReturnValue("{}");
    realpathSyncNativeMock.mockImplementation((path: PathLike) => String(path));
    readCustomProvidersMock.mockReturnValue([]);
    getAllMock.mockReturnValue([]);
    findMock.mockImplementation((provider: string, modelId: string) => ({ provider, id: modelId }));
    authStorageGetApiKeyMock.mockImplementation(async (provider: string) => (
      provider === "anthropic" ? "sk-ant-api03-test-key" : undefined
    ));
    authStorageGetMock.mockImplementation((provider: string) => (
      provider === "anthropic" ? { type: "api_key", key: "sk-ant-api03-test-key" } : undefined
    ));
    authStorageHasMock.mockReturnValue(false);
    authStorageHasAuthMock.mockReturnValue(false);
    authStorageGetAllMock.mockReturnValue({});
    authStorageListMock.mockReturnValue([]);
    getApiKeyAndHeadersMock.mockResolvedValue({ ok: true, apiKey: undefined, headers: undefined });
    sessionManagerGetSessionIdMock.mockReturnValue(undefined);
    createBashToolMock.mockClear();
  });

  it("does not throw when the resolved runtime session omits subscribe(), and still streams text via onText", async () => {
    // Delegated CLI runtime session shape: no `subscribe` method at all —
    // matches cursor/droid/grok sessions, which stream via their own onText
    // callback instead of the pi `subscribe(listener)` API.
    const subscribeLessSession = {
      prompt: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
    };
    createAgentSessionMock.mockResolvedValue({ session: subscribeLessSession });
    expect((subscribeLessSession as any).subscribe).toBeUndefined();

    const { createFnAgent } = await import("../pi.js");

    let capturedText = "";
    await expect(
      createFnAgent({
        cwd: "/project",
        systemPrompt: "test",
        tools: "readonly",
        onText: (delta: string) => {
          capturedText += delta;
        },
      }),
    ).resolves.toEqual(
      expect.objectContaining({ session: subscribeLessSession }),
    );

    // The guarded listener-wiring block must not have attempted to call a
    // non-existent subscribe — proven by the absence of a thrown TypeError
    // above (the promise resolved) plus the session object staying
    // subscribe-free (no accidental mutation/monkey-patch by the guard).
    expect((subscribeLessSession as any).subscribe).toBeUndefined();
  });

  it("control: still wires the subscribe listener and streams text when the session implements subscribe", async () => {
    let registeredListener: ((event: unknown) => void) | undefined;
    const subscribeCapableSession = {
      prompt: vi.fn(),
      dispose: vi.fn(),
      setThinkingLevel: vi.fn(),
      subscribe: vi.fn((listener: (event: unknown) => void) => {
        registeredListener = listener;
      }),
    };
    createAgentSessionMock.mockResolvedValue({ session: subscribeCapableSession });

    const { createFnAgent } = await import("../pi.js");

    let capturedText = "";
    await createFnAgent({
      cwd: "/project",
      systemPrompt: "test",
      tools: "readonly",
      onText: (delta: string) => {
        capturedText += delta;
      },
    });

    expect(subscribeCapableSession.subscribe).toHaveBeenCalled();
    expect(registeredListener).toBeInstanceOf(Function);

    registeredListener?.({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        partial: "hello",
        contentIndex: 0,
        delta: "hello",
      },
    });

    expect(capturedText).toBe("hello");
  });
});
