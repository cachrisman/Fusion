import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { useState } from "react";
import type { GlobalSettings, Settings } from "@fusion/core";
import { McpServersCard, type McpSettingsScope } from "../McpServersCard";

/*
 * FNXC:McpConfig 2026-07-12-00:00:
 * Component-level coverage for the Settings \u2192 MCP "Connect / Authorize" action: renders only for
 * oauth-configured (sse/streamable-http + auth) servers, reflects all four auth states from the existing
 * /mcp/validate probe (no-token, connected, expired-with-refresh-silent, refresh-failed), never leaves an
 * empty button shell for non-oauth servers, and behaves identically under both global and project scope (both
 * sections render the same McpServersCard).
 */

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string, values?: Record<string, string | number>) => {
      if (!values) return fallback;
      return Object.entries(values).reduce((text, [key, value]) => text.replace(`{{${key}}}`, String(value)), fallback);
    },
  }),
}));

function mockFetch(opts: {
  validateByName?: Record<string, { status: "valid" | "unreachable" | "error"; message?: string }>;
  authorizeUrl?: string;
} = {}) {
  const authorizeCalls: Array<{ scope: string; name: string }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/mcp/discovered")) {
      return new Response(JSON.stringify({ sources: [], servers: [], errors: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "/api/secrets" && (!init?.method || init.method === "GET")) {
      return new Response(JSON.stringify({ secrets: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "/api/mcp/validate") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { server?: { name?: string } };
      const name = body.server?.name ?? "default";
      const result = opts.validateByName?.[name] ?? { status: "valid" as const, message: "ok" };
      return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.startsWith("/api/mcp/oauth/authorize")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { scope: string; name: string };
      authorizeCalls.push(body);
      return new Response(JSON.stringify({ authorizationUrl: opts.authorizeUrl ?? "https://auth.example.test/authorize" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: `Unhandled ${url}` }), { status: 500, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, authorizeCalls };
}

function renderCard(options: { scope: McpSettingsScope; form?: Settings; globalSettings?: Pick<GlobalSettings, "mcpServers"> | null }) {
  let currentForm: Settings = options.form ?? ({} as Settings);
  const addToast = vi.fn();
  function Harness() {
    const [form, setFormState] = useState<Settings>(currentForm);
    currentForm = form;
    return (
      <McpServersCard
        scope={options.scope}
        form={form}
        globalSettings={options.globalSettings}
        addToast={addToast}
        setForm={(next) => {
          setFormState((previous) => {
            const resolved = typeof next === "function" ? next(previous) : next;
            currentForm = resolved;
            return resolved;
          });
        }}
      />
    );
  }
  const result = render(<Harness />);
  return { ...result, addToast, getForm: () => currentForm };
}

const OAUTH_SERVER = {
  name: "oauth-srv",
  transport: "sse" as const,
  url: "https://mcp.example.test/sse",
  auth: { type: "oauth" as const, authorizationServerUrl: "https://auth.example.test" },
};

const PLAIN_STDIO_SERVER = { name: "plain-stdio", transport: "stdio" as const, command: "node" };
const HEADERS_ONLY_SERVER = { name: "headers-only", transport: "streamable-http" as const, url: "https://plain.example.test/mcp" };

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("768px"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MCP OAuth Connect/Authorize action", () => {
  it.each(["global", "project"] as const)("renders the Authorize CTA for an oauth server with no token, in %s scope", async (scope) => {
    mockFetch({ validateByName: { "oauth-srv": { status: "error", message: "oauth: needs re-authorize (no stored token)" } } });
    renderCard({
      scope,
      form: { mcpServers: { enabled: true, servers: [OAUTH_SERVER] } } as Settings,
      globalSettings: scope === "project" ? { mcpServers: { enabled: true, servers: [] } } : undefined,
    });

    const action = await screen.findByTestId("mcp-oauth-oauth-srv");
    await waitFor(() => expect(within(action).getByRole("button", { name: /Authorize/i })).toBeInTheDocument());
  });

  it("renders a connected badge when the probe reports valid (also covers silent expired-with-refresh)", async () => {
    mockFetch({ validateByName: { "oauth-srv": { status: "valid", message: "ok" } } });
    renderCard({ scope: "global", form: { mcpServers: { enabled: true, servers: [OAUTH_SERVER] } } as Settings });

    const action = await screen.findByTestId("mcp-oauth-oauth-srv");
    await waitFor(() => expect(within(action).getByTestId("mcp-oauth-badge-oauth-srv")).toHaveTextContent("Connected"));
    expect(within(action).queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders an actionable Re-authorize CTA when refresh has failed", async () => {
    mockFetch({ validateByName: { "oauth-srv": { status: "error", message: "oauth: needs re-authorize (refresh failed)" } } });
    renderCard({ scope: "global", form: { mcpServers: { enabled: true, servers: [OAUTH_SERVER] } } as Settings });

    const action = await screen.findByTestId("mcp-oauth-oauth-srv");
    await waitFor(() => expect(within(action).getByRole("button", { name: /Re-authorize/i })).toBeInTheDocument());
  });

  it("starts the authorize flow via the start route, scoped to this server", async () => {
    const { authorizeCalls } = mockFetch({ validateByName: { "oauth-srv": { status: "error", message: "oauth: needs re-authorize (no stored token)" } } });
    const openSpy = vi.spyOn(window, "open").mockReturnValue({ closed: true } as Window);
    renderCard({ scope: "project", form: { mcpServers: { enabled: true, servers: [OAUTH_SERVER] } } as Settings });

    const action = await screen.findByTestId("mcp-oauth-oauth-srv");
    const button = await waitFor(() => within(action).getByRole("button", { name: /Authorize/i }));
    fireEvent.click(button);

    await waitFor(() => expect(authorizeCalls).toContainEqual({ scope: "project", name: "oauth-srv" }));
    expect(openSpy).toHaveBeenCalledWith("https://auth.example.test/authorize", "fusion-mcp-oauth", expect.any(String));
  });

  it("never renders an empty button shell / orphaned click target for non-oauth (stdio) or headers-only servers", async () => {
    mockFetch();
    renderCard({
      scope: "project",
      form: { mcpServers: { enabled: true, servers: [PLAIN_STDIO_SERVER, HEADERS_ONLY_SERVER] } } as Settings,
    });

    await screen.findByTestId("mcp-server-row-plain-stdio");
    expect(screen.queryByTestId("mcp-oauth-plain-stdio")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mcp-oauth-headers-only")).not.toBeInTheDocument();
  });

  it("does not crash with an empty/undefined server list", async () => {
    mockFetch();
    renderCard({ scope: "global", form: {} as Settings });
    expect(await screen.findByText("No MCP servers configured.")).toBeInTheDocument();
  });
});
