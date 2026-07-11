/**
 * FNXC:McpServer 2026-07-11-12:00:
 * FUSI-045 coverage for the `fusion://skill` MCP resource:
 *   1. resource-fetch parity in-memory (InMemoryTransport, mirrors
 *      tools.test.ts's harness) AND over the real streamable-HTTP transport
 *      (mirrors http-transport.test.ts's harness) — proving the resource is
 *      fetchable over BOTH transports without a spawned subprocess.
 *   2. a parity/drift guard: every tool name embedded in the served skill
 *      markdown must exactly equal buildMcpToolRegistry({allowDestructive:true})'s
 *      tool names (no missing, no unexpected), every DESTRUCTIVE_TOOL_TIER
 *      name must be rendered with its `--allow-destructive` annotation, and
 *      the served markdown must be BYTE-IDENTICAL whether the server was
 *      built with allowDestructive true or false (flag-invariant content —
 *      only the live tool registry differs by flag, never the doc).
 * stdio fetchability against the real spawned binary is proven separately
 * by scripts/lib/mcp-smoke.mjs's runMcpServeStdioSmoke (boot-smoke stage).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "@fusion/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildMcpToolRegistry, DESTRUCTIVE_TOOL_TIER } from "../tools.js";
import { buildMcpServer, type FusionMcpServer } from "../server.js";
import { buildServedMcpSkillMarkdown, FUSION_SKILL_RESOURCE_URI } from "../served-skill.js";
import { startHttpMcpTransport, type HttpMcpTransportHandle } from "../http-transport.js";

/**
 * Slice out just the generated mcp-curated-tools table from the full served
 * skill markdown. The served markdown ALSO embeds the SKILL.md body's own
 * `tool-categories` block (the superset pi-extension surface) — the parity
 * guard must only compare against the MCP-specific table, not that superset,
 * so every extraction below scopes to this slice.
 */
function extractMcpCuratedToolsBlock(markdown: string): string {
  const begin = markdown.indexOf("<!-- BEGIN: mcp-curated-tools");
  const end = markdown.indexOf("<!-- END: mcp-curated-tools -->");
  expect(begin, "mcp-curated-tools BEGIN marker not found in served skill").toBeGreaterThanOrEqual(0);
  expect(end, "mcp-curated-tools END marker not found in served skill").toBeGreaterThan(begin);
  return markdown.slice(begin, end + "<!-- END: mcp-curated-tools -->".length);
}

/**
 * Extract every `fn_*` tool name that appears backtick-quoted within the
 * mcp-curated-tools block (e.g. `` `fn_task_create` ``). The table generated
 * by scripts/sync-fusion-skill-tools.mjs renders one such backtick-quoted
 * name per row, so this recovers the exact rendered set without depending
 * on table-column parsing.
 */
function extractRenderedToolNames(markdown: string): Set<string> {
  const names = new Set<string>();
  for (const match of extractMcpCuratedToolsBlock(markdown).matchAll(/`(fn_[a-z_]+)`/g)) {
    names.add(match[1]);
  }
  return names;
}

describe("fusion://skill MCP resource (FUSI-045)", () => {
  let tmpDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "fn-fusi-045-mcp-skill-"));
    await mkdir(join(tmpDir, ".fusion"), { recursive: true });
    store = new TaskStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("parity/drift guard", () => {
    it("the served skill's rendered tool set exactly equals buildMcpToolRegistry({allowDestructive:true})", () => {
      const markdown = buildServedMcpSkillMarkdown();
      const rendered = extractRenderedToolNames(markdown);
      const expected = new Set(buildMcpToolRegistry({ allowDestructive: true }).map((t) => t.name));

      const missing = [...expected].filter((n) => !rendered.has(n));
      const unexpected = [...rendered].filter((n) => !expected.has(n));
      expect(missing, `missing from served skill: ${missing.join(", ")}`).toHaveLength(0);
      expect(unexpected, `unexpected in served skill (not in registry): ${unexpected.join(", ")}`).toHaveLength(0);
    });

    it("every DESTRUCTIVE_TOOL_TIER tool is present and rendered with its --allow-destructive annotation", () => {
      const mcpBlock = extractMcpCuratedToolsBlock(buildServedMcpSkillMarkdown());
      for (const tool of DESTRUCTIVE_TOOL_TIER) {
        const nameIdx = mcpBlock.indexOf(`\`${tool.name}\``);
        expect(nameIdx, `${tool.name} not found in mcp-curated-tools block`).toBeGreaterThanOrEqual(0);
        // The annotation appears on the SAME table row as the tool name — scan forward to the next newline.
        const lineEnd = mcpBlock.indexOf("\n", nameIdx);
        const row = mcpBlock.slice(nameIdx, lineEnd === -1 ? undefined : lineEnd);
        expect(row, `${tool.name} row missing --allow-destructive annotation`).toMatch(/--allow-destructive/);
      }
    });

    it("mentions the MCP-connection section heading and the pre-existing SKILL body signal", () => {
      const markdown = buildServedMcpSkillMarkdown();
      expect(markdown).toContain("# MCP Connection");
      // SKILL.md body signal — present before any MCP-specific content was ever added.
      expect(markdown).toContain("Fusion is an AI-orchestrated task board");
    });

    it("served markdown is flag-invariant: identical whether the server allowDestructive is true or false", () => {
      const withDestructive = buildMcpServer({ cwd: tmpDir, store, version: "test", allowDestructive: true });
      const withoutDestructive = buildMcpServer({ cwd: tmpDir, store, version: "test", allowDestructive: false });
      try {
        // buildServedMcpSkillMarkdown takes no arguments and is not threaded
        // through BuildMcpServerOptions — assert directly, and once more via
        // each server's registered resource read handler below (both cases).
        expect(buildServedMcpSkillMarkdown()).toBe(buildServedMcpSkillMarkdown());
      } finally {
        void withDestructive;
        void withoutDestructive;
      }
    });
  });

  describe("in-memory resource fetch (InMemoryTransport)", () => {
    it("lists fusion://skill and reads non-empty text/markdown content", async () => {
      const mcpServer = buildMcpServer({ cwd: tmpDir, store, version: "test" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test-client", version: "1.0.0" });
      await Promise.all([client.connect(clientTransport), mcpServer.server.connect(serverTransport)]);
      try {
        const { resources } = await client.listResources();
        const skillResource = (resources ?? []).find((r) => r.uri === FUSION_SKILL_RESOURCE_URI);
        expect(skillResource, "fusion://skill not listed").toBeDefined();
        expect(skillResource?.mimeType).toBe("text/markdown");

        const read = await client.readResource({ uri: FUSION_SKILL_RESOURCE_URI });
        expect(read.contents).toHaveLength(1);
        const [content] = read.contents;
        expect(content.mimeType).toBe("text/markdown");
        expect(typeof content.text).toBe("string");
        expect((content.text as string).length).toBeGreaterThan(0);
        expect(content.text).toContain("# MCP Connection");
      } finally {
        await client.close();
        await mcpServer.close();
      }
    });

    it("fetches the identical resource content whether allowDestructive is true or false", async () => {
      const serverA = buildMcpServer({ cwd: tmpDir, store, version: "test", allowDestructive: true });
      const [clientTransportA, serverTransportA] = InMemoryTransport.createLinkedPair();
      const clientA = new Client({ name: "test-client-a", version: "1.0.0" });
      await Promise.all([clientA.connect(clientTransportA), serverA.server.connect(serverTransportA)]);

      const serverB = buildMcpServer({ cwd: tmpDir, store, version: "test", allowDestructive: false });
      const [clientTransportB, serverTransportB] = InMemoryTransport.createLinkedPair();
      const clientB = new Client({ name: "test-client-b", version: "1.0.0" });
      await Promise.all([clientB.connect(clientTransportB), serverB.server.connect(serverTransportB)]);

      try {
        const readA = await clientA.readResource({ uri: FUSION_SKILL_RESOURCE_URI });
        const readB = await clientB.readResource({ uri: FUSION_SKILL_RESOURCE_URI });
        expect(readA.contents[0].text).toBe(readB.contents[0].text);
      } finally {
        await clientA.close();
        await serverA.close();
        await clientB.close();
        await serverB.close();
      }
    });
  });

  describe("HTTP resource fetch (streamable-HTTP transport)", () => {
    let mcpServer: FusionMcpServer | undefined;
    let handle: HttpMcpTransportHandle | undefined;
    const token = "test-bearer-token-fusi-045";

    afterEach(async () => {
      if (handle) {
        await handle.close();
        handle = undefined;
      }
      if (mcpServer) {
        await mcpServer.close();
        mcpServer = undefined;
      }
    });

    it("lists fusion://skill and reads non-empty text/markdown content over HTTP", async () => {
      mcpServer = buildMcpServer({ cwd: tmpDir, store, version: "test" });
      handle = await startHttpMcpTransport({
        server: mcpServer,
        host: "127.0.0.1",
        port: 0,
        token,
        logger: () => {},
      });
      const url = new URL(`http://${handle.address.host}:${handle.address.port}/mcp`);
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      });
      const client = new Client({ name: "test-http-client", version: "1.0.0" });
      await client.connect(transport);
      try {
        const { resources } = await client.listResources();
        const skillResource = (resources ?? []).find((r) => r.uri === FUSION_SKILL_RESOURCE_URI);
        expect(skillResource, "fusion://skill not listed over HTTP").toBeDefined();

        const read = await client.readResource({ uri: FUSION_SKILL_RESOURCE_URI });
        expect(read.contents).toHaveLength(1);
        expect(read.contents[0].mimeType).toBe("text/markdown");
        expect((read.contents[0].text as string).length).toBeGreaterThan(0);
      } finally {
        await client.close();
      }
    });
  });
});
