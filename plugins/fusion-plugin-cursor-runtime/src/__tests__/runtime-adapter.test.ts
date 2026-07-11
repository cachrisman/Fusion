import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

const probeCursorBinaryMock = vi.hoisted(() => vi.fn());
const spawnCursorExecutionMock = vi.hoisted(() => vi.fn());
const killCursorExecutionMock = vi.hoisted(() => vi.fn());

vi.mock("../probe.js", () => ({
  probeCursorBinary: probeCursorBinaryMock,
}));

vi.mock("../execution-process-manager.js", async () => {
  const actual = await vi.importActual<typeof import("../execution-process-manager.js")>("../execution-process-manager.js");
  return {
    ...actual,
    spawnCursorExecution: spawnCursorExecutionMock,
    killCursorExecution: killCursorExecutionMock,
  };
});

import { CursorRuntimeAdapter } from "../runtime-adapter.js";

function makeChild() {
  const child = new EventEmitter() as any;
  child.stdout = new Readable({ read() {} });
  child.stderr = new EventEmitter();
  child.killed = false;
  child.exitCode = null;
  child.kill = vi.fn();
  return child;
}

function emitLines(child: any, lines: string[]) {
  for (const line of lines) {
    child.stdout.push(`${line}\n`);
  }
}

function endStream(child: any) {
  child.stdout.push(null);
}

describe("CursorRuntimeAdapter", () => {
  beforeEach(() => {
    probeCursorBinaryMock.mockReset();
    spawnCursorExecutionMock.mockReset();
    killCursorExecutionMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("createSession", () => {
    it("creates a proper AgentSessionResult-shaped session when authenticated", async () => {
      probeCursorBinaryMock.mockResolvedValue({
        available: true,
        authenticated: true,
        binaryPath: "cursor-agent",
        binaryName: "cursor-agent",
        probeDurationMs: 5,
      });

      const adapter = new CursorRuntimeAdapter();
      const result = await adapter.createSession({ cwd: "/tmp/work", systemPrompt: "sys", defaultModelId: "sonnet-4.5" });

      expect(result.sessionFile).toBeUndefined();
      expect(result.session.model).toBe("sonnet-4.5");
      expect(result.session.systemPrompt).toBe("sys");
      expect(result.session.cwd).toBe("/tmp/work");
      expect(result.session.mode).toBe("agent");
      expect(adapter.describeModel(result.session)).toBe("cursor/sonnet-4.5");
    });

    it("falls back to cursor-agent's own 'auto' default only when defaultModelId is genuinely absent", async () => {
      probeCursorBinaryMock.mockResolvedValue({ available: true, authenticated: true, binaryName: "cursor-agent", probeDurationMs: 1 });
      const adapter = new CursorRuntimeAdapter();
      const result = await adapter.createSession({ cwd: "/tmp/work", systemPrompt: "sys" });
      expect(result.session.model).toBe("auto");
    });

    it("maps tools:readonly to --mode plan lane", async () => {
      probeCursorBinaryMock.mockResolvedValue({ available: true, authenticated: true, binaryName: "cursor-agent", probeDurationMs: 1 });
      const adapter = new CursorRuntimeAdapter();
      const result = await adapter.createSession({ cwd: "/tmp/work", systemPrompt: "sys", tools: "readonly" });
      expect(result.session.mode).toBe("plan");
    });

    it("throws a distinct runtime-blocked error when the binary is unavailable", async () => {
      probeCursorBinaryMock.mockResolvedValue({
        available: false,
        authenticated: false,
        reason: "cursor-agent/cursor not found on PATH",
        probeDurationMs: 1,
      });
      const adapter = new CursorRuntimeAdapter();
      await expect(adapter.createSession({ cwd: "/tmp/work", systemPrompt: "sys" })).rejects.toMatchObject({
        name: "CursorRuntimeBlockedError",
        kind: "unavailable",
        message: "cursor-agent/cursor not found on PATH",
      });
    });

    it("throws a distinct runtime-blocked error for a locked keychain", async () => {
      probeCursorBinaryMock.mockResolvedValue({
        available: true,
        authenticated: false,
        reason: "macOS login keychain is locked",
        probeDurationMs: 1,
      });
      const adapter = new CursorRuntimeAdapter();
      await expect(adapter.createSession({ cwd: "/tmp/work", systemPrompt: "sys" })).rejects.toMatchObject({
        kind: "keychain-locked",
        message: "macOS login keychain is locked",
      });
    });

    it("throws a distinct runtime-blocked error for a missing IDE install", async () => {
      probeCursorBinaryMock.mockResolvedValue({
        available: true,
        authenticated: false,
        reason: "Cursor IDE installation not found",
        probeDurationMs: 1,
      });
      const adapter = new CursorRuntimeAdapter();
      await expect(adapter.createSession({ cwd: "/tmp/work", systemPrompt: "sys" })).rejects.toMatchObject({
        kind: "missing-ide",
        message: "Cursor IDE installation not found",
      });
    });

    it("throws a distinct runtime-blocked error for a plain unauthenticated state", async () => {
      probeCursorBinaryMock.mockResolvedValue({
        available: true,
        authenticated: false,
        reason: "cursor-agent reports not authenticated",
        probeDurationMs: 1,
      });
      const adapter = new CursorRuntimeAdapter();
      await expect(adapter.createSession({ cwd: "/tmp/work", systemPrompt: "sys" })).rejects.toMatchObject({
        kind: "unauthenticated",
        message: "cursor-agent reports not authenticated",
      });
    });
  });

  describe("promptWithFallback", () => {
    async function makeSession(overrides?: Record<string, unknown>) {
      probeCursorBinaryMock.mockResolvedValue({ available: true, authenticated: true, binaryPath: "cursor-agent", probeDurationMs: 1 });
      const adapter = new CursorRuntimeAdapter();
      const onText = vi.fn();
      const onThinking = vi.fn();
      const { session } = await adapter.createSession({
        cwd: "/tmp/work",
        systemPrompt: "sys",
        defaultModelId: "auto",
        onText,
        onThinking,
        ...overrides,
      });
      return { adapter, session, onText, onThinking };
    }

    it("bridges thinking/assistant events to callbacks and resolves with usage on a successful stream", async () => {
      const { adapter, session, onText, onThinking } = await makeSession();
      const child = makeChild();
      spawnCursorExecutionMock.mockReturnValue(child);

      const pending = adapter.promptWithFallback(session, "Say PONG");

      emitLines(child, [
        JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1", model: "Auto" }),
        JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Say PONG" }] } }),
        JSON.stringify({ type: "thinking", subtype: "delta", text: "thinking about it" }),
        JSON.stringify({ type: "thinking", subtype: "completed" }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "PONG" }] } }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "PONG",
          session_id: "sess-1",
          usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 1 },
        }),
      ]);
      endStream(child);
      child.emit("close", 0);

      const result = await pending;
      expect(onThinking).toHaveBeenCalledWith("thinking about it");
      expect(onText).toHaveBeenCalledWith("PONG");
      expect(result).toEqual({
        stopReason: "stop",
        usage: { inputTokens: 100, outputTokens: 10, cachedTokens: 5, cacheWriteTokens: 1, totalTokens: 116 },
      });
      expect(session.sessionId).toBe("sess-1");
    });

    it("rejects (does not silently swallow) an is_error:true result event", async () => {
      const { adapter, session } = await makeSession();
      const child = makeChild();
      spawnCursorExecutionMock.mockReturnValue(child);

      const pending = adapter.promptWithFallback(session, "do something risky");
      emitLines(child, [
        JSON.stringify({ type: "result", subtype: "error", is_error: true, error: "sandbox denied write", session_id: "sess-2" }),
      ]);
      endStream(child);
      child.emit("close", 0);

      await expect(pending).rejects.toThrow(/sandbox denied write/);
    });

    it("includes --resume with the prior turn's session id on a second turn", async () => {
      const { adapter, session } = await makeSession();
      const firstChild = makeChild();
      spawnCursorExecutionMock.mockReturnValueOnce(firstChild);
      const firstPending = adapter.promptWithFallback(session, "first turn");
      emitLines(firstChild, [
        JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "sess-resume-1" }),
      ]);
      endStream(firstChild);
      firstChild.emit("close", 0);
      await firstPending;

      const secondChild = makeChild();
      spawnCursorExecutionMock.mockReturnValueOnce(secondChild);
      const secondPending = adapter.promptWithFallback(session, "second turn");
      emitLines(secondChild, [
        JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "sess-resume-1" }),
      ]);
      endStream(secondChild);
      secondChild.emit("close", 0);
      await secondPending;

      const secondCallArgs = spawnCursorExecutionMock.mock.calls[1][1] as string[];
      expect(secondCallArgs).toEqual(expect.arrayContaining(["--resume", "sess-resume-1"]));
    });

    it("passes --mode plan for a readonly-tools session", async () => {
      const { adapter, session } = await makeSession({ tools: "readonly" });
      const child = makeChild();
      spawnCursorExecutionMock.mockReturnValue(child);
      const pending = adapter.promptWithFallback(session, "review this");
      emitLines(child, [JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" })]);
      endStream(child);
      child.emit("close", 0);
      await pending;

      const args = spawnCursorExecutionMock.mock.calls[0][1] as string[];
      expect(args).toEqual(expect.arrayContaining(["--mode", "plan"]));
    });

    it("kills the child process and rejects on abort mid-stream", async () => {
      const { adapter, session } = await makeSession();
      const child = makeChild();
      spawnCursorExecutionMock.mockReturnValue(child);

      const controller = new AbortController();
      const pending = adapter.promptWithFallback(session, "long running task", { signal: controller.signal });

      emitLines(child, [JSON.stringify({ type: "thinking", subtype: "delta", text: "still working" })]);
      controller.abort();

      await expect(pending).rejects.toThrow(/aborted/i);
      expect(killCursorExecutionMock).toHaveBeenCalledWith(child);
    });

    it("rejects if the process closes before ever emitting a result event", async () => {
      const { adapter, session } = await makeSession();
      const child = makeChild();
      spawnCursorExecutionMock.mockReturnValue(child);

      const pending = adapter.promptWithFallback(session, "hello");
      endStream(child);
      child.emit("close", 1);

      await expect(pending).rejects.toThrow(/before emitting a result event/);
    });
  });

  describe("describeModel", () => {
    it("prefixes a bare model id with cursor/", () => {
      const adapter = new CursorRuntimeAdapter();
      expect(adapter.describeModel({ model: "pro" } as any)).toBe("cursor/pro");
    });

    it("does not double-prefix a model id that already carries cursor/", () => {
      const adapter = new CursorRuntimeAdapter();
      expect(adapter.describeModel({ model: "cursor/pro" } as any)).toBe("cursor/pro");
    });
  });
});
