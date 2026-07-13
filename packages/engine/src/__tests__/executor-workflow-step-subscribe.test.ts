import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedExecSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

/*
FNXC:SessionWiring 2026-07-13-00:00:
Regression coverage for FUSI-088 (Runfusion/Fusion#1946-class no-verdict
defect): the workflow-step execution path in `executor.ts` previously
accumulated the step `output` (later parsed for a verdict) ONLY inside an
UNGUARDED `session.subscribe(...)` call. A resolved runtime session that omits
`subscribe` (as delegated CLI runtime sessions do) made this throw
`TypeError: session.subscribe is not a function`, and — critically — even a
bare try/catch around the throw would have left `output` empty, still
producing the "(no feedback captured)" / "failed before producing a verdict"
no-verdict signature.

These tests drive `TaskExecutor.executeWorkflowStep` (via the shared
`executor-test-helpers.js` harness, which mocks `createFnAgent` directly) with
a session object that OMITS `subscribe`, and assert:
  1. No `session.subscribe is not a function` throw — the workflow step still
     produces a real outcome instead of failing before a verdict.
  2. Step `output` is still accumulated (non-empty) via the `onText` fallback
     now threaded through `createResolvedAgentSession`'s options.
  3. A real verdict is parsed from that output (not a malformed/no-verdict
     result).
  4. Control case: a subscribe-capable session still streams via its own
     `subscribe` listener and produces the same verdict (no regression).
*/

function quietGit() {
  mockedExecSync.mockImplementation(() => Buffer.from(""));
}

function makeExecutor(store: ReturnType<typeof createMockStore>) {
  const agentStore = { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() };
  return new TaskExecutor(store as any, "/tmp/test", { agentStore } as any);
}

function baseTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-SUBSCRIBE-1",
    title: "Subscribe guard",
    description: "verify subscribe-less session still produces a verdict",
    column: "in-progress" as const,
    worktree: "/tmp/wt",
    branch: "fusion/fn-subscribe-1",
    baseCommitSha: "abc123",
    dependencies: [],
    steps: [{ name: "s", status: "in-progress" as const }],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function workflowStep(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: "step:subscribe-guard",
    name: "Subscribe Guard Step",
    description: "",
    mode: "prompt" as const,
    phase: "pre-merge" as const,
    gateMode: "advisory" as const,
    prompt: "Check the subscribe guard.",
    toolMode: "readonly" as const,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const VERDICT_OUTPUT = '{"verdict":"APPROVE","notes":"looks good"}';

/**
 * Mocks createFnAgent to resolve a subscribe-LESS session (mirrors a
 * delegated CLI runtime session shape) that streams the verdict text purely
 * via the forwarded `onText` option — never via `subscribe`.
 */
function mockSubscribeLessSession(output = VERDICT_OUTPUT) {
  mockedCreateFnAgent.mockImplementation(async (opts: any) => {
    const session: any = {
      state: {},
      // Intentionally no `subscribe` method at all.
      prompt: vi.fn(async () => {
        opts.onText?.(output);
      }),
      dispose: vi.fn(),
    };
    expect(session.subscribe).toBeUndefined();
    return { session };
  });
}

/** Control: a subscribe-capable session streaming via its own listener. */
function mockSubscribeCapableSession(output = VERDICT_OUTPUT) {
  mockedCreateFnAgent.mockImplementation(async (opts: any) => {
    const listeners: Array<(event: any) => void> = [];
    const session: any = {
      state: {},
      subscribe: (fn: (event: any) => void) => {
        listeners.push(fn);
        return () => {};
      },
      prompt: vi.fn(async () => {
        for (const fn of listeners) {
          fn({
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              partial: output,
              contentIndex: 0,
              delta: output,
            },
          });
        }
      }),
      dispose: vi.fn(),
    };
    return { session };
  });
}

describe("executor workflow-step subscribe guard (FUSI-088)", () => {
  beforeEach(() => {
    resetExecutorMocks();
    quietGit();
  });

  it("does not throw and still produces a real verdict when the session omits subscribe()", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({});
    const executor = makeExecutor(store);
    mockSubscribeLessSession();

    const outcome = await (executor as any).executeWorkflowStep(
      baseTask(),
      workflowStep(),
      "/tmp/wt",
      {},
      undefined,
    );

    // (1) No throw reached this point — the promise resolved with an outcome.
    expect(outcome).toBeDefined();
    // (2)+(3) A real verdict was parsed (output was captured via the onText
    // fallback, not lost to an unguarded/uncaught subscribe throw).
    expect(outcome.verdict).toBe("APPROVE");
    expect(outcome.output).toBeTruthy();
    expect(outcome.output).not.toBe("(no feedback captured)");
    expect(outcome.error).toBeUndefined();

    // The synthesized non-verdict failure string must never appear.
    const logMessages = store.logEntry.mock.calls.map((call: unknown[]) => call[1]);
    for (const message of logMessages) {
      expect(String(message)).not.toMatch(/failed before producing a verdict/i);
      expect(String(message)).not.toMatch(/subscribe is not a function/i);
    }
  });

  it("control: still produces the same verdict when the session implements subscribe", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({});
    const executor = makeExecutor(store);
    mockSubscribeCapableSession();

    const outcome = await (executor as any).executeWorkflowStep(
      baseTask(),
      workflowStep(),
      "/tmp/wt",
      {},
      undefined,
    );

    expect(outcome.verdict).toBe("APPROVE");
    expect(outcome.output).toBeTruthy();
    expect(outcome.output).not.toBe("(no feedback captured)");
  });
});
