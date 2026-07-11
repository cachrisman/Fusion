/**
 * Builds the Fusion operator MCP server — the stdio-transport counterpart to
 * `fn mcp add/list/...` (which configures Fusion as an MCP *client*). This
 * module owns `McpServer` + tool-registry construction; transport
 * construction/connection is deliberately kept out of this file (see
 * {@link buildMcpServer}) so a future streamable-HTTP transport can be added
 * without a rewrite of the tool wiring.
 *
 * FNXC:McpServer 2026-07-10-21:00:
 * Reuses the SAME `@modelcontextprotocol/sdk` package (pinned at ^1.0.0 —
 * matching packages/engine/src/mcp-session-tools.ts, the existing MCP
 * *client* usage) but the **server** exports (`server/mcp.js`) instead of
 * the client exports. Do not hand-roll the protocol.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z, type ZodTypeAny } from "zod";
import type { TaskStore } from "@fusion/core";
import { buildMcpToolRegistry, type McpJsonSchema, type McpToolRuntimeContext } from "./tools.js";
import { buildServedMcpSkillMarkdown, FUSION_SKILL_RESOURCE_URI } from "./served-skill.js";

/**
 * Converts one of this registry's plain JSON-Schema tool inputs into the raw
 * zod shape `McpServer.registerTool` requires. Deliberately narrow: the
 * curated v1 registry only ever declares `string` / `number` / `boolean` /
 * `array` (of strings) / `enum` properties (see packages/cli/src/mcp-server/tools.ts),
 * so this adapter does not attempt to support arbitrary JSON Schema.
 */
function jsonSchemaPropertyToZod(prop: Record<string, unknown>): ZodTypeAny {
  const enumValues = Array.isArray(prop.enum) ? (prop.enum as string[]) : undefined;
  if (enumValues && enumValues.length > 0) {
    return z.enum(enumValues as [string, ...string[]]).describe(typeof prop.description === "string" ? prop.description : "");
  }
  switch (prop.type) {
    case "string":
      return z.string().describe(typeof prop.description === "string" ? prop.description : "");
    case "number":
      return z.number().describe(typeof prop.description === "string" ? prop.description : "");
    case "boolean":
      return z.boolean().describe(typeof prop.description === "string" ? prop.description : "");
    case "array": {
      const items = prop.items as Record<string, unknown> | undefined;
      const itemSchema = items ? jsonSchemaPropertyToZod(items) : z.string();
      return z.array(itemSchema).describe(typeof prop.description === "string" ? prop.description : "");
    }
    default:
      return z.unknown().describe(typeof prop.description === "string" ? prop.description : "");
  }
}

/** Converts a registry tool's {@link McpJsonSchema} into a zod raw shape. */
export function jsonSchemaToZodShape(schema: McpJsonSchema): Record<string, ZodTypeAny> {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(properties)) {
    const zodType = jsonSchemaPropertyToZod(prop as Record<string, unknown>);
    shape[key] = required.has(key) ? zodType : zodType.optional();
  }
  return shape;
}

export interface BuildMcpServerOptions {
  /** Resolved project root (contains `.fusion/`) every tool call operates against. */
  cwd: string;
  /** Initialized TaskStore for the resolved project. */
  store: TaskStore;
  /** Server version string; defaults to "0.0.0" when omitted (tests). */
  version?: string;
  /*
  FNXC:McpServer 2026-07-10-21:00:
  Off-by-default destructive-tool opt-in (FUSI-002). `fn mcp serve` runs as a
  local stdio subprocess launched directly by the operator with the
  operator's own OS privileges (see the trust-model note in tools.ts) — the
  gate here is not an authentication boundary, it is a deliberate "did the
  operator explicitly ask for delete tools" confirmation so a client that
  merely connects to the curated v1 read/safe-mutation surface can never
  invoke fn_task_delete / fn_agent_delete / fn_workflow_delete by accident.
  Defaults to `false` so every existing `fn mcp serve` invocation keeps the
  FUSI-001 delete-free tool set.
  */
  allowDestructive?: boolean;
}

export interface FusionMcpServer {
  server: McpServer;
  /** Connect the server to a transport (stdio in `fn mcp serve`, in-memory in tests). */
  connect: (transport: Transport) => Promise<void>;
  /** Close the underlying MCP server. Does NOT close the TaskStore — callers own that lifecycle. */
  close: () => Promise<void>;
}

/**
 * Constructs an `McpServer` and registers every tool {@link buildMcpToolRegistry}
 * returns for the resolved `allowDestructive` flag. Does not create or own a
 * transport — callers (e.g. `runMcpServe` in packages/cli/src/commands/mcp.ts,
 * or a test) decide how to connect it. This keeps the seam open for a future
 * non-stdio transport without touching tool registration.
 */
export function buildMcpServer(options: BuildMcpServerOptions): FusionMcpServer {
  const { cwd, store, version, allowDestructive = false } = options;
  /*
  FNXC:McpServer 2026-07-11-12:00:
  FUSI-045 discoverability pointer: appended (not replacing) the existing
  instructions wording so a connecting MCP client is told, in-protocol,
  where to find the full operator-surface writeup (transport model, curated
  tool list, invocation conventions) without needing to read repo source.
  Both the allowDestructive and non-allowDestructive instructions branches
  get the SAME one-line pointer — the resource itself is flag-invariant (see
  served-skill.ts), only the live tool registry differs by flag.
  */
  const instructionsPointer = `Read the "${FUSION_SKILL_RESOURCE_URI}" resource for the full operator surface (transport model, curated tool list, invocation conventions).`;
  const server = new McpServer(
    { name: "fusion", version: version ?? "0.0.0" },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: allowDestructive
        ? `Fusion operator MCP server — curated read + safe-mutation task/agent/workflow controls, PLUS destructive delete tools (--allow-destructive is enabled). ${instructionsPointer}`
        : `Fusion operator MCP server — curated read + safe-mutation task/agent/workflow controls. ${instructionsPointer}`,
    },
  );

  const runtimeCtx: McpToolRuntimeContext = { cwd, allowDestructive };
  const registry = buildMcpToolRegistry(runtimeCtx);

  for (const tool of registry) {
    const inputShape = jsonSchemaToZodShape(tool.inputSchema);
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: inputShape },
      async (args) => {
        const result = await tool.handler(store, (args ?? {}) as Record<string, unknown>, runtimeCtx);
        return result as never;
      },
    );
  }

  /*
  FNXC:McpServer 2026-07-11-12:00:
  Registers the readable `fusion://skill` resource (FUSI-045) — a stable,
  documented URI an MCP client can `resources/read` to get a self-describing
  operator-surface skill markdown (existing pi-extension SKILL.md body PLUS
  the MCP-connection section). Deliberately a STATIC resource (fixed URI, no
  template/params) since the served content never varies per-request — the
  same markdown is returned to every reader, on both stdio and HTTP
  transports. See served-skill.ts for composition and the flag-invariance
  rationale (never gated on `allowDestructive`).
  */
  server.registerResource(
    "fusion-skill",
    FUSION_SKILL_RESOURCE_URI,
    {
      title: "Fusion operator skill",
      description:
        "Self-describing Fusion operator surface: task/agent/workflow/mission concepts, MCP transport model, curated tool list, and tool-invocation conventions.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: buildServedMcpSkillMarkdown(),
        },
      ],
    }),
  );

  return {
    server,
    connect: (transport: Transport) => server.connect(transport),
    close: () => server.close(),
  };
}
