import { describe, expect, it } from "vitest";

import { getRateLimitedTaskCopy, isRateLimitedTask, isUsageLimitTaskError } from "../rateLimitedTaskState";

describe("isUsageLimitTaskError", () => {
  it.each([
    ["429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"...\"}}"],
    ["Error: overloaded_error — the model is overloaded"],
    ["Too many requests, please slow down"],
    ["quota exceeded for this billing period"],
    ["insufficient credit balance"],
    ["529 Service Unavailable"],
  ])("classifies usage-limit string as true: %s", (message) => {
    expect(isUsageLimitTaskError(message)).toBe(true);
  });

  it.each([
    ["TypeError: Cannot read properties of undefined (reading 'foo')"],
    ["Build failed: tsc exited with code 1"],
    ["Lint failed: 3 errors in src/index.ts"],
    ["ENOENT: no such file or directory"],
    ["Permission denied (403)"],
  ])("classifies genuine failure string as false: %s", (message) => {
    expect(isUsageLimitTaskError(message)).toBe(false);
  });

  it("handles undefined/null/empty error text", () => {
    expect(isUsageLimitTaskError(undefined)).toBe(false);
    expect(isUsageLimitTaskError(null)).toBe(false);
    expect(isUsageLimitTaskError("")).toBe(false);
  });
});

describe("isRateLimitedTask", () => {
  it("returns false for non-failed tasks regardless of error text", () => {
    expect(isRateLimitedTask({ status: "in-progress", error: "429 rate_limit_error" })).toBe(false);
    expect(isRateLimitedTask({ status: "done", error: "429 rate_limit_error" })).toBe(false);
  });

  it("returns true for a failed task whose error text matches a usage-limit pattern", () => {
    expect(
      isRateLimitedTask({
        status: "failed",
        error: '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests exceeded"}}',
      }),
    ).toBe(true);
  });

  it("returns false for a failed task with a genuine terminal failure, even under an unrelated global pause", () => {
    expect(
      isRateLimitedTask(
        { status: "failed", error: "Build failed: tsc exited with code 1" },
        { globalPaused: true, globalPauseReason: "manual" },
      ),
    ).toBe(false);
  });

  it("returns false for a genuine terminal failure even while the board IS paused for rate-limit (does not over-classify)", () => {
    expect(
      isRateLimitedTask(
        { status: "failed", error: "" },
        { globalPaused: true, globalPauseReason: "rate-limit" },
      ),
    ).toBe(false);
  });

  it("returns true for a failed task with non-matching-but-present error text while the board is paused for rate-limit", () => {
    // FUSI-064 not yet landed: the engine still marks such tasks `failed`, and the
    // captured error text may be wrapped/truncated and not cleanly regex-match, but
    // the systemic rate-limit pause is the far more likely cause than a coincidental
    // unrelated failure at the same moment.
    expect(
      isRateLimitedTask(
        { status: "failed", error: "session ended unexpectedly" },
        { globalPaused: true, globalPauseReason: "rate-limit" },
      ),
    ).toBe(true);
  });

  it("returns false when globalPauseReason is set but globalPaused is false", () => {
    expect(
      isRateLimitedTask(
        { status: "failed", error: "session ended unexpectedly" },
        { globalPaused: false, globalPauseReason: "rate-limit" },
      ),
    ).toBe(false);
  });

  it("handles missing error/undefined task.error gracefully", () => {
    expect(isRateLimitedTask({ status: "failed", error: undefined })).toBe(false);
    expect(isRateLimitedTask({ status: "failed", error: undefined }, { globalPaused: true, globalPauseReason: "rate-limit" })).toBe(false);
  });
});

describe("getRateLimitedTaskCopy", () => {
  it("returns a populated headline + key", () => {
    const copy = getRateLimitedTaskCopy();
    expect(copy.headline.length).toBeGreaterThan(0);
    expect(copy.headlineKey).toBe("taskStatus.rateLimited.headline");
  });
});
