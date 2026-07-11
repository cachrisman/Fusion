import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import {
  buildCursorExecutionArgs,
  captureBoundedStderr,
  killCursorExecution,
  spawnCursorExecution,
} from "../execution-process-manager.js";

function makeProc() {
  const proc = new EventEmitter() as any;
  proc.killed = false;
  proc.exitCode = null;
  proc.pid = 123;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn((signal?: string) => {
    if (signal === "SIGKILL") proc.killed = true;
  });
  return proc;
}

describe("buildCursorExecutionArgs", () => {
  it("builds the default-mode headless streaming invocation", () => {
    const args = buildCursorExecutionArgs({ cwd: "/tmp/work", model: "auto", prompt: "do the thing" });

    expect(args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--force",
      "--trust",
      "--workspace",
      "/tmp/work",
      "--model",
      "auto",
      "do the thing",
    ]);
  });

  it("uses --workspace for cwd, never -w/--worktree", () => {
    const args = buildCursorExecutionArgs({ cwd: "/tmp/work", model: "auto", prompt: "p" });
    expect(args).toContain("--workspace");
    expect(args).not.toContain("-w");
    expect(args).not.toContain("--worktree");
  });

  it("includes --resume when a chat id is supplied", () => {
    const args = buildCursorExecutionArgs({
      cwd: "/tmp/work",
      model: "auto",
      prompt: "p",
      resumeChatId: "chat-123",
    });
    expect(args).toEqual(expect.arrayContaining(["--resume", "chat-123"]));
  });

  it("omits --resume when no chat id is supplied", () => {
    const args = buildCursorExecutionArgs({ cwd: "/tmp/work", model: "auto", prompt: "p" });
    expect(args).not.toContain("--resume");
  });

  it("includes --mode plan for the plan lane", () => {
    const args = buildCursorExecutionArgs({ cwd: "/tmp/work", model: "auto", prompt: "p", mode: "plan" });
    expect(args).toEqual(expect.arrayContaining(["--mode", "plan"]));
  });

  it("includes --mode ask for the ask lane", () => {
    const args = buildCursorExecutionArgs({ cwd: "/tmp/work", model: "auto", prompt: "p", mode: "ask" });
    expect(args).toEqual(expect.arrayContaining(["--mode", "ask"]));
  });

  it("omits --mode entirely for the default agent lane", () => {
    const args = buildCursorExecutionArgs({ cwd: "/tmp/work", model: "auto", prompt: "p", mode: "agent" });
    expect(args).not.toContain("--mode");
  });

  it("passes through --add-dir for each extra root and --approve-mcps when set", () => {
    const args = buildCursorExecutionArgs({
      cwd: "/tmp/work",
      model: "auto",
      prompt: "p",
      addDirs: ["/tmp/extra-a", "/tmp/extra-b"],
      approveMcps: true,
    });
    expect(args).toEqual(
      expect.arrayContaining(["--add-dir", "/tmp/extra-a", "--add-dir", "/tmp/extra-b", "--approve-mcps"]),
    );
  });

  it("places the prompt as the final positional argument", () => {
    const args = buildCursorExecutionArgs({ cwd: "/tmp/work", model: "auto", prompt: "final prompt text" });
    expect(args[args.length - 1]).toBe("final prompt text");
  });
});

describe("spawnCursorExecution", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("spawns with piped stdio and never fully buffers (no 'inherit')", () => {
    const proc = makeProc();
    spawnMock.mockReturnValueOnce(proc);

    const result = spawnCursorExecution("cursor-agent", ["-p"], "/tmp/work");

    expect(result).toBe(proc);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [binary, args, options] = spawnMock.mock.calls[0] as [string, string[], { stdio: string[]; cwd: string; shell: boolean }];
    expect(binary).toBe("cursor-agent");
    expect(args).toEqual(["-p"]);
    expect(options.cwd).toBe("/tmp/work");
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(options.stdio).not.toContain("inherit");
  });

  it("only enables shell on win32", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    spawnMock.mockReturnValueOnce(makeProc());
    spawnCursorExecution("cursor-agent", [], "/tmp/work");
    expect(spawnMock.mock.calls[0][2].shell).toBe(false);
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });
});

describe("captureBoundedStderr", () => {
  it("accumulates stderr chunks up to a bounded cap and never throws on overflow", () => {
    const proc = makeProc();
    const getStderr = captureBoundedStderr(proc);
    proc.stderr.emit("data", Buffer.from("a".repeat(3000)));
    proc.stderr.emit("data", Buffer.from("b".repeat(3000)));
    const captured = getStderr();
    expect(captured.length).toBeLessThanOrEqual(4001); // cap + ellipsis char
    expect(captured.endsWith("…")).toBe(true);
  });

  it("returns empty string when stderr never emits", () => {
    const proc = makeProc();
    const getStderr = captureBoundedStderr(proc);
    expect(getStderr()).toBe("");
  });
});

describe("killCursorExecution", () => {
  it("sends SIGTERM first, then escalates to SIGKILL after the grace period", () => {
    vi.useFakeTimers();
    const proc = makeProc();
    const killSpy = vi.spyOn(proc, "kill");

    killCursorExecution(proc, 1000);
    expect(killSpy).toHaveBeenCalledWith("SIGTERM");
    expect(killSpy).not.toHaveBeenCalledWith("SIGKILL");

    vi.advanceTimersByTime(1000);
    expect(killSpy).toHaveBeenCalledWith("SIGKILL");
    vi.useRealTimers();
  });

  it("does not escalate to SIGKILL if the process exits within the grace period", () => {
    vi.useFakeTimers();
    const proc = makeProc();
    const killSpy = vi.spyOn(proc, "kill");

    killCursorExecution(proc, 1000);
    proc.exitCode = 0;
    proc.emit("exit", 0);
    vi.advanceTimersByTime(1000);

    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith("SIGTERM");
    vi.useRealTimers();
  });

  it("is a no-op when the process is already dead", () => {
    const proc = makeProc();
    proc.exitCode = 0;
    const killSpy = vi.spyOn(proc, "kill");
    killCursorExecution(proc);
    expect(killSpy).not.toHaveBeenCalled();
  });
});
