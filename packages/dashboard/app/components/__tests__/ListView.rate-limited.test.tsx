/*
FNXC:RateLimitResume 2026-07-11-00:00 (FUSI-065):
List-row-surface coverage for the usage-limit calm state, at both the desktop
table (.list-row/.list-status-badge) and mobile card (.list-card) render
paths. A usage-limit task must use the warning-tier "rate-limited" modifier
instead of "failed" on both; a genuine terminal failure control must be
UNAFFECTED — still red "failed".
*/
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Task, TaskDetail } from "@fusion/core";
import { ListView } from "../ListView";
import { scopedKey } from "../../utils/projectStorage";

vi.mock("../../api", () => ({
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchSettings: vi.fn().mockResolvedValue({
    modelPresets: [],
    autoSelectModelPreset: false,
    defaultPresetBySize: {},
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 30000,
    groupOverlappingFiles: true,
    autoMerge: true,
  }),
  fetchGlobalSettings: vi.fn().mockResolvedValue({}),
  fetchTaskDetail: vi.fn(),
  batchUpdateTaskModels: vi.fn(),
  fetchNodes: vi.fn(() => new Promise(() => {})),
  fetchBoardWorkflows: vi.fn(() => new Promise(() => {})),
  rebuildTaskSpec: vi.fn().mockResolvedValue({}),
  refreshPrStatus: vi.fn().mockResolvedValue({}),
  updateTask: vi.fn(),
  api: vi.fn().mockResolvedValue({ sessions: [] }),
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn(() => () => {}),
}));

vi.mock("../QuickEntryBox", () => ({
  QuickEntryBox: () => null,
}));

vi.mock("../TaskDetailModal", () => ({
  TaskDetailContent: ({ task }: { task: Task | TaskDetail }) => <div data-testid="task-detail-content">{task.id}</div>,
}));

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: vi.fn(), confirmWithChoice: vi.fn() }),
}));

const mockAddToast = vi.fn();
const TEST_PROJECT_ID = "proj-123";

const createMockTask = (overrides: Partial<Task> = {}): Task => ({
  id: "FN-001",
  description: "Test task description",
  title: "Test Task",
  column: "triage",
  dependencies: [],
  steps: [],
  currentStep: 0,
  status: "pending",
  paused: false,
  log: [],
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
  ...overrides,
});

function renderListView(props: Partial<React.ComponentProps<typeof ListView>> = {}) {
  const defaultProps = {
    tasks: [],
    onMoveTask: vi.fn(async () => createMockTask()),
    onRetryTask: vi.fn(async () => createMockTask()),
    onDeleteTask: vi.fn(async () => createMockTask()),
    onMergeTask: vi.fn(async () => ({ merged: false })),
    onResetTask: vi.fn(async () => createMockTask()),
    onDuplicateTask: vi.fn(async () => createMockTask()),
    onOpenDetail: vi.fn(),
    addToast: mockAddToast,
    globalPaused: false,
    onNewTask: vi.fn(),
    projectId: TEST_PROJECT_ID,
  };

  return render(<ListView {...defaultProps} {...props} />);
}

function ensureMatchMedia() {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", { writable: true, value: vi.fn() });
  }
}

function mockMobileViewport() {
  ensureMatchMedia();
  Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
  return vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query === "(max-width: 768px)" || query === "(max-width: 768px), (max-height: 480px)",
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as unknown as MediaQueryList);
}

function mockDesktopViewport() {
  ensureMatchMedia();
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
  return vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as unknown as MediaQueryList);
}

const RATE_LIMIT_ERROR = '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests exceeded"}}';
const GENUINE_FAILURE_ERROR = "Build failed: tsc exited with code 1";

function showStatusColumnByDefault() {
  localStorage.setItem(
    scopedKey("kb-dashboard-list-columns", TEST_PROJECT_ID),
    JSON.stringify(["title", "status", "column", "dependencies", "progress"]),
  );
}

describe("ListView rate-limited calm state (FUSI-065)", () => {
  it("renders a 'Rate limited' warning-tier badge (not 'failed') on the desktop table row", () => {
    mockDesktopViewport();
    showStatusColumnByDefault();
    const tasks = [createMockTask({ id: "FN-001", status: "failed", column: "in-progress", error: RATE_LIMIT_ERROR })];
    const { container } = renderListView({ tasks });

    const row = screen.getByText("FN-001").closest("tr");
    expect(row?.className).not.toMatch(/\bfailed\b/);
    expect(row?.className).toContain("rate-limited");

    const badge = screen.getByText("Rate limited");
    expect(badge.className).toContain("rate-limited");
    expect(badge.className).not.toMatch(/\bfailed\b/);
    expect(container.querySelector(".list-status-badge.failed")).toBeNull();
  });

  it("classifies calm via globalPauseReason='rate-limit' even without own error text matching", () => {
    mockDesktopViewport();
    showStatusColumnByDefault();
    const tasks = [createMockTask({ id: "FN-002", status: "failed", column: "in-progress", error: "session ended unexpectedly" })];
    renderListView({ tasks, globalPaused: true, globalPauseReason: "rate-limit" } as any);

    const row = screen.getByText("FN-002").closest("tr");
    expect(row?.className).toContain("rate-limited");
    expect(row?.className).not.toMatch(/\bfailed\b/);
  });

  it("control: a genuine terminal failure stays red 'failed' on the desktop table row", () => {
    mockDesktopViewport();
    showStatusColumnByDefault();
    const tasks = [createMockTask({ id: "FN-003", status: "failed", column: "in-progress", error: GENUINE_FAILURE_ERROR })];
    renderListView({ tasks });

    const row = screen.getByText("FN-003").closest("tr");
    expect(row?.className).toContain("failed");
    expect(row?.className).not.toContain("rate-limited");

    const badge = screen.getByText("failed");
    expect(badge.className).toContain("failed");
  });

  it("renders the warning-tier badge on the mobile card row too", () => {
    mockMobileViewport();
    const tasks = [createMockTask({ id: "FN-004", status: "failed", column: "in-progress", error: RATE_LIMIT_ERROR })];
    renderListView({ tasks });

    const badge = screen.getByText("Rate limited");
    expect(badge.className).toContain("rate-limited");
    expect(badge.className).not.toMatch(/\bfailed\b/);
  });

  it("control: a genuine terminal failure stays red 'failed' on the mobile card row", () => {
    mockMobileViewport();
    const tasks = [createMockTask({ id: "FN-005", status: "failed", column: "in-progress", error: GENUINE_FAILURE_ERROR })];
    renderListView({ tasks });

    const badge = screen.getByText("failed");
    expect(badge.className).toContain("failed");
    expect(badge.className).not.toContain("rate-limited");
  });
});
