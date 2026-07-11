/*
FNXC:RateLimitResume 2026-07-11-00:00 (FUSI-065):
Card-surface coverage for the usage-limit calm state. A usage-limit task must
render the warning-tier RateLimitedTaskNotice instead of the red card-error
box, with no `card.failed`/`card-status-badge…failed` co-application, at both
desktop and mobile. A genuine terminal failure control must be UNAFFECTED —
still red "failed" treatment with the primary card-error-retry-btn.
*/
import { afterEach, describe, it, expect, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { TaskCard } from "../TaskCard";
import type { Task } from "@fusion/core";
import * as api from "../../api";

vi.mock("../ProviderIcon", () => ({
  ProviderIcon: () => null,
}));

vi.mock("../PluginSlot", () => ({
  PluginSlot: () => null,
}));

vi.mock("../../hooks/useTaskDiffStats", () => ({
  useTaskDiffStats: () => ({ stats: null, loading: false }),
}));

vi.mock("../../hooks/useBadgeWebSocket", () => ({
  useBadgeWebSocket: () => ({
    badgeUpdates: new Map(),
    isConnected: true,
    subscribeToBadge: vi.fn(),
    unsubscribeFromBadge: vi.fn(),
  }),
}));

vi.mock("../../hooks/useBatchBadgeFetch", () => ({
  getFreshBatchData: vi.fn(() => null),
}));

vi.mock("../../api", () => ({
  fetchTaskDetail: vi.fn(),
  uploadAttachment: vi.fn(),
  fetchMission: vi.fn(),
  fetchAgent: vi.fn(),
  fetchAgents: vi.fn(),
  rebuildTaskSpec: vi.fn(),
  fetchWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, orphaned: [] }),
  fetchUsageData: vi.fn(),
}));

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: vi.fn(), confirmWithChoice: vi.fn() }),
}));

vi.mock("../../hooks/useToast", () => ({
  useToast: () => ({
    addToast: vi.fn(),
    removeToast: vi.fn(),
    toasts: [],
  }),
}));

const mockFetchUsageData = vi.mocked(api.fetchUsageData);

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "Test task",
    column: "in-progress",
    status: "failed" as Task["status"],
    steps: [],
    dependencies: [],
    description: "",
    ...overrides,
  } as Task;
}

const noop = () => {};

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  window.dispatchEvent(new Event("resize"));
}

const RATE_LIMIT_ERROR = '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests exceeded"}}';
const GENUINE_FAILURE_ERROR = "Build failed: tsc exited with code 1 (src/index.ts:42)";

afterEach(() => {
  vi.clearAllMocks();
  setViewport(1024);
});

describe("TaskCard rate-limited calm state (FUSI-065)", () => {
  it.each([1024, 375])("renders the warning-tier notice, not card-error, at viewport width %ipx", async (width) => {
    setViewport(width);
    mockFetchUsageData.mockResolvedValue({ providers: [] });

    const { container } = render(
      <TaskCard task={makeTask({ error: RATE_LIMIT_ERROR })} onOpenDetail={noop} addToast={noop} onRetryTask={vi.fn()} />,
    );
    await act(async () => {
      await flushPromises();
    });

    expect(screen.getByTestId("rate-limited-notice")).toBeInTheDocument();
    expect(container.querySelector(".card-error")).toBeNull();
    expect(container.querySelector(".card.failed")).toBeNull();
    expect(container.querySelector(".card-status-badge.failed")).toBeNull();
  });

  it("collapses the raw JSON error behind a <details> disclosure", async () => {
    mockFetchUsageData.mockResolvedValue({ providers: [] });

    render(<TaskCard task={makeTask({ error: RATE_LIMIT_ERROR })} onOpenDetail={noop} addToast={noop} />);
    await act(async () => {
      await flushPromises();
    });

    const notice = screen.getByTestId("rate-limited-notice");
    const details = notice.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.querySelector("pre")?.textContent).toBe(RATE_LIMIT_ERROR);
  });

  it("renders Retry as a secondary action inside the notice, not the primary card-error-retry-btn", async () => {
    mockFetchUsageData.mockResolvedValue({ providers: [] });

    const { container } = render(
      <TaskCard task={makeTask({ error: RATE_LIMIT_ERROR })} onOpenDetail={noop} addToast={noop} onRetryTask={vi.fn()} />,
    );
    await act(async () => {
      await flushPromises();
    });

    expect(container.querySelector(".card-error-retry-btn")).toBeNull();
    expect(container.querySelector(".rate-limited-notice__retry-btn")).not.toBeNull();
  });

  it("classifies calm via globalPauseReason='rate-limit' even without own error text matching", async () => {
    mockFetchUsageData.mockResolvedValue({ providers: [] });

    const { container } = render(
      <TaskCard
        task={makeTask({ error: "session ended unexpectedly" })}
        onOpenDetail={noop}
        addToast={noop}
        globalPaused
        globalPauseReason="rate-limit"
      />,
    );
    await act(async () => {
      await flushPromises();
    });

    expect(screen.getByTestId("rate-limited-notice")).toBeInTheDocument();
    expect(container.querySelector(".card-error")).toBeNull();
  });

  it.each([1024, 375])("control: a genuine terminal failure stays red with primary Retry at viewport width %ipx", async (width) => {
    setViewport(width);
    mockFetchUsageData.mockResolvedValue({ providers: [] });

    const { container } = render(
      <TaskCard task={makeTask({ error: GENUINE_FAILURE_ERROR })} onOpenDetail={noop} addToast={noop} onRetryTask={vi.fn()} />,
    );
    await act(async () => {
      await flushPromises();
    });

    expect(screen.queryByTestId("rate-limited-notice")).toBeNull();
    expect(container.querySelector(".card-error")).not.toBeNull();
    expect(container.querySelector(".card.failed")).not.toBeNull();
    expect(container.querySelector(".card-status-badge.failed")).not.toBeNull();
    expect(container.querySelector(".card-error-retry-btn")).not.toBeNull();
  });

  it("control: a genuine failure under an unrelated global pause still stays red", async () => {
    mockFetchUsageData.mockResolvedValue({ providers: [] });

    const { container } = render(
      <TaskCard
        task={makeTask({ error: GENUINE_FAILURE_ERROR })}
        onOpenDetail={noop}
        addToast={noop}
        globalPaused
        globalPauseReason="manual"
      />,
    );
    await act(async () => {
      await flushPromises();
    });

    expect(screen.queryByTestId("rate-limited-notice")).toBeNull();
    expect(container.querySelector(".card-error")).not.toBeNull();
  });
});
