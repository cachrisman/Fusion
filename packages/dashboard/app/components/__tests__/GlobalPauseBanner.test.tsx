import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalPauseBanner } from "../GlobalPauseBanner";
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

describe("GlobalPauseBanner", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetchUsageData.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing (no shell) when not paused", async () => {
    mockFetchUsageData.mockResolvedValue({ providers: [] });

    const { container, queryByTestId } = render(
      <GlobalPauseBanner globalPaused={false} globalPauseReason={undefined} />,
    );
    await act(async () => {
      await flushPromises();
    });

    expect(queryByTestId("global-pause-banner")).toBeNull();
    expect(container.querySelector('[aria-live="polite"]')).toBeNull();
  });

  it("renders nothing (no shell) when paused for 'manual'", async () => {
    mockFetchUsageData.mockResolvedValue({ providers: [] });

    const { container, queryByTestId } = render(
      <GlobalPauseBanner globalPaused={true} globalPauseReason="manual" />,
    );
    await act(async () => {
      await flushPromises();
    });

    expect(queryByTestId("global-pause-banner")).toBeNull();
    expect(container.querySelector('[aria-live="polite"]')).toBeNull();
  });

  it("renders the ETA copy with a countdown when paused for rate-limit with a known resetAt", async () => {
    const resetAt = new Date(Date.now() + 90 * 60 * 1000).toISOString(); // 1h30m out
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

    render(<GlobalPauseBanner globalPaused={true} globalPauseReason="rate-limit" />);

    const banner = await screen.findByTestId("global-pause-banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveAttribute("aria-live", "polite");
    expect(banner.textContent).toContain("Paused");
    expect(banner.textContent).toContain("resumes ~");
    expect(banner.textContent).toContain("1h 30m");
  });

  it("renders the no-ETA fallback when resetAt is unknown", async () => {
    mockFetchUsageData.mockResolvedValue({ providers: [claudeProvider({ windows: [] })] });

    render(<GlobalPauseBanner globalPaused={true} globalPauseReason="rate-limit" />);

    const banner = await screen.findByTestId("global-pause-banner");
    expect(banner.textContent).toBe("Paused — Claude limit, resuming automatically");
  });

  it("ignores a non-exhausted window even if its resetAt is soonest", async () => {
    const soonResetAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    mockFetchUsageData.mockResolvedValue({
      providers: [
        claudeProvider({
          windows: [
            {
              label: "Session (5h)",
              percentUsed: 50,
              percentLeft: 50,
              resetText: "resets in 5m",
              resetMs: 5 * 60 * 1000,
              resetAt: soonResetAt,
            },
          ],
        }),
      ],
    });

    render(<GlobalPauseBanner globalPaused={true} globalPauseReason="rate-limit" />);

    const banner = await screen.findByTestId("global-pause-banner");
    expect(banner.textContent).toBe("Paused — Claude limit, resuming automatically");
  });

  it("ships responsive mobile scaffolding for the banner stack", () => {
    const css = readFileSync(resolve(__dirname, "..", "GlobalPauseBanner.css"), "utf8");

    expect(css).toContain("@media (max-width: 768px)");
    expect(css).toContain(".global-pause-banner");
  });
});
