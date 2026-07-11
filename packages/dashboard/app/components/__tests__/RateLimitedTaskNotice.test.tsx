import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitedTaskNotice } from "../RateLimitedTaskNotice";
import * as api from "../../api";
import type { ProviderUsage } from "../../api";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string, values?: Record<string, string>) => {
      let text = fallback ?? _key;
      if (values) {
        for (const [key, value] of Object.entries(values)) {
          text = text.replace(`{{${key}}}`, value);
        }
      }
      return text;
    },
  }),
}));

vi.mock("../../api", () => ({
  fetchUsageData: vi.fn(),
}));

const mockFetchUsageData = vi.mocked(api.fetchUsageData);

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function claudeProvider(overrides: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    name: "Claude",
    icon: "🟠",
    status: "ok",
    windows: [],
    ...overrides,
  };
}

const RAW_ERROR = '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests exceeded"}}';

describe("RateLimitedTaskNotice", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetchUsageData.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the ETA copy when a reset is known", async () => {
    const resetAt = new Date(Date.now() + 90 * 60 * 1000).toISOString();
    mockFetchUsageData.mockResolvedValue({
      providers: [
        claudeProvider({
          windows: [
            {
              label: "Session (5h)",
              percentUsed: 100,
              percentLeft: 0,
              resetText: "resets in 1h 30m",
              resetMs: 90 * 60 * 1000,
              resetAt,
            },
          ],
        }),
      ],
    });

    render(<RateLimitedTaskNotice error={RAW_ERROR} variant="compact" />);
    await act(async () => {
      await flushPromises();
    });

    const notice = await screen.findByTestId("rate-limited-notice");
    expect(notice).toHaveAttribute("role", "status");
    expect(notice).toHaveAttribute("aria-live", "polite");
    expect(notice.textContent).toContain("Rate limit reached");
    expect(notice.textContent).toContain("Resumes automatically ~");
    expect(notice.textContent).toContain("1h 30m");
  });

  it("renders the graceful no-ETA fallback (never a fabricated time) when reset is unknown", async () => {
    mockFetchUsageData.mockResolvedValue({ providers: [claudeProvider({ windows: [] })] });

    render(<RateLimitedTaskNotice error={RAW_ERROR} variant="full" />);
    await act(async () => {
      await flushPromises();
    });

    const notice = await screen.findByTestId("rate-limited-notice");
    expect(notice.textContent).toContain("Resuming automatically once the provider limit resets");
    expect(notice.textContent).not.toMatch(/Resumes automatically ~/);
  });

  it("collapses the raw error text inside a <details> disclosure, not inline visible text", async () => {
    mockFetchUsageData.mockResolvedValue({ providers: [] });

    render(<RateLimitedTaskNotice error={RAW_ERROR} />);
    await act(async () => {
      await flushPromises();
    });

    const notice = await screen.findByTestId("rate-limited-notice");
    const details = notice.querySelector("details");
    expect(details).not.toBeNull();
    // The raw error text is present in the DOM (inside <details><pre>) but the
    // details element itself is closed by default — it is not "inline visible text".
    expect(details?.hasAttribute("open")).toBe(false);
    expect(details?.querySelector("pre")?.textContent).toBe(RAW_ERROR);
    expect(details?.querySelector("summary")).not.toBeNull();
  });

  it("renders no <details> when no error text is supplied", async () => {
    mockFetchUsageData.mockResolvedValue({ providers: [] });

    render(<RateLimitedTaskNotice />);
    await act(async () => {
      await flushPromises();
    });

    const notice = await screen.findByTestId("rate-limited-notice");
    expect(notice.querySelector("details")).toBeNull();
  });

  it("renders Retry as a secondary (non-primary) action when onRetry is supplied", async () => {
    mockFetchUsageData.mockResolvedValue({ providers: [] });
    const onRetry = vi.fn();

    render(<RateLimitedTaskNotice error={RAW_ERROR} onRetry={onRetry} />);
    await act(async () => {
      await flushPromises();
    });

    const notice = await screen.findByTestId("rate-limited-notice");
    const retryBtn = notice.querySelector(".rate-limited-notice__retry-btn");
    expect(retryBtn).not.toBeNull();
    expect(retryBtn?.className).not.toContain("btn-primary");
  });

  it("renders no Retry button when onRetry is omitted", async () => {
    mockFetchUsageData.mockResolvedValue({ providers: [] });

    render(<RateLimitedTaskNotice error={RAW_ERROR} />);
    await act(async () => {
      await flushPromises();
    });

    const notice = await screen.findByTestId("rate-limited-notice");
    expect(notice.querySelector(".rate-limited-notice__retry-btn")).toBeNull();
  });

  it("never applies --color-error/failed classes", async () => {
    mockFetchUsageData.mockResolvedValue({ providers: [] });

    render(<RateLimitedTaskNotice error={RAW_ERROR} />);
    await act(async () => {
      await flushPromises();
    });

    const notice = await screen.findByTestId("rate-limited-notice");
    expect(notice.className).not.toMatch(/\bfailed\b/);
    expect(notice.className).not.toMatch(/error/i);
  });

  it("ships responsive mobile scaffolding", () => {
    const css = readFileSync(resolve(__dirname, "..", "RateLimitedTaskNotice.css"), "utf8");
    expect(css).toContain("@media (max-width: 768px)");
    expect(css).toContain("--color-warning");
    expect(css).not.toContain("--color-error");
  });
});
