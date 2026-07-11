/*
FNXC:RateLimitResume 2026-07-11-00:00 (FUSI-065):
Task-detail-surface coverage for the usage-limit calm state. A usage-limit
task must render the warning-tier RateLimitedTaskNotice ("waiting for reset,
resuming automatically") instead of the red "Task Failed" detail-error-alert,
with the raw JSON collapsed and Retry demoted to secondary, at both desktop
and mobile. A genuine terminal failure control must be UNAFFECTED — still
"Task Failed" with primary Retry.
*/
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  noopRetry,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import { TaskDetailModal } from "../TaskDetailModal";
import * as api from "../../api";

setupTaskDetailModalHooks();

const mockFetchUsageData = vi.mocked(api.fetchUsageData);

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  window.dispatchEvent(new Event("resize"));
}

const RATE_LIMIT_ERROR = '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests exceeded"}}';
const GENUINE_FAILURE_ERROR = "Build failed: tsc exited with code 1 (src/index.ts:42)";

afterEach(() => {
  setViewport(1024);
});

describe("TaskDetailModal rate-limited calm state (FUSI-065)", () => {
  it.each([1024, 375])("renders the warning-tier notice instead of 'Task Failed' at viewport width %ipx", async (width) => {
    setViewport(width);
    mockFetchUsageData.mockResolvedValue({ providers: [] });

    const { container } = render(
      <TaskDetailModal
        task={makeTask({ column: "todo", status: "failed", error: RATE_LIMIT_ERROR })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onRetryTask={noopRetry}
        addToast={noop}
      />,
    );
    await screen.findByTestId("rate-limited-notice");

    expect(screen.queryByText("Task Failed")).not.toBeInTheDocument();
    expect(container.querySelector(".detail-error-alert")).toBeNull();
    expect(screen.getByText(/Rate limit reached/)).toBeInTheDocument();
  });

  it("renders the reset ETA when known", async () => {
    const resetAt = new Date(Date.now() + 45 * 60 * 1000).toISOString();
    mockFetchUsageData.mockResolvedValue({
      providers: [
        {
          name: "Claude",
          icon: "🟠",
          status: "ok",
          windows: [
            { label: "Session (5h)", percentUsed: 100, percentLeft: 0, resetText: "resets in 45m", resetMs: 45 * 60 * 1000, resetAt },
          ],
        },
      ],
    });

    render(
      <TaskDetailModal
        task={makeTask({ column: "todo", status: "failed", error: RATE_LIMIT_ERROR })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onRetryTask={noopRetry}
        addToast={noop}
      />,
    );
    const notice = await screen.findByTestId("rate-limited-notice");
    expect(notice.textContent).toContain("Resumes automatically ~");
    // Real elapsed time between resetAt creation and assertion can shave a
    // minute off the countdown, so match the format loosely (e.g. "44m"/"45m").
    expect(notice.textContent).toMatch(/\(in 4[0-5]m\)/);
  });

  it("renders the graceful no-ETA fallback (never a fabricated time) when reset is unknown", async () => {
    mockFetchUsageData.mockResolvedValue({ providers: [] });

    render(
      <TaskDetailModal
        task={makeTask({ column: "todo", status: "failed", error: RATE_LIMIT_ERROR })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onRetryTask={noopRetry}
        addToast={noop}
      />,
    );
    const notice = await screen.findByTestId("rate-limited-notice");
    expect(notice.textContent).toContain("Resuming automatically once the provider limit resets");
  });

  it("collapses the raw JSON error behind a <details> disclosure, and Retry is secondary", async () => {
    mockFetchUsageData.mockResolvedValue({ providers: [] });

    render(
      <TaskDetailModal
        task={makeTask({ column: "todo", status: "failed", error: RATE_LIMIT_ERROR })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onRetryTask={noopRetry}
        addToast={noop}
      />,
    );
    const notice = await screen.findByTestId("rate-limited-notice");
    const details = notice.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.querySelector("pre")?.textContent).toBe(RATE_LIMIT_ERROR);

    const retryBtn = notice.querySelector(".rate-limited-notice__retry-btn");
    expect(retryBtn).not.toBeNull();
    expect(retryBtn?.className).not.toContain("btn-primary");
  });

  it.each([1024, 375])("control: a genuine terminal failure stays 'Task Failed' with primary Retry at viewport width %ipx", async (width) => {
    setViewport(width);
    mockFetchUsageData.mockResolvedValue({ providers: [] });

    const { container } = render(
      <TaskDetailModal
        task={makeTask({ column: "todo", status: "failed", error: GENUINE_FAILURE_ERROR })}
        onClose={noop}
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        onRetryTask={noopRetry}
        addToast={noop}
      />,
    );
    await screen.findByText("Task Failed");

    expect(screen.queryByTestId("rate-limited-notice")).toBeNull();
    expect(screen.getByText(GENUINE_FAILURE_ERROR)).toBeInTheDocument();
    expect(container.querySelector(".detail-error-alert")).not.toBeNull();
  });
});
