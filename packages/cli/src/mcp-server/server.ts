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
import { basename } from "node:path";
import type { TaskStore } from "@fusion/core";
import { buildMcpToolRegistry, type McpJsonSchema, type McpToolRuntimeContext } from "./tools.js";
import { buildServedMcpSkillMarkdown, FUSION_SKILL_RESOURCE_URI } from "./served-skill.js";
import { McpProjectSession } from "./project-session.js";

/**
 * Converts one of this registry's plain JSON-Schema tool inputs into the raw
 * zod shape `McpServer.registerTool` requires. Originally deliberately narrow
 * (the curated v1 registry only ever declared `string` / `number` / `boolean` /
 * `array` (of strings) / `enum` properties — see packages/cli/src/mcp-server/tools.ts).
 *
 * FNXC:McpWorkflow 2026-07-11-00:00:
 * FUSI-043 extends this adapter to recurse into nested `type:"object"` (via
 * `properties`/`required`) and `type:"array"` of objects, because the new
 * typed `fn_workflow_create`/`fn_workflow_update` IR schema (see the
 * `workflowIrSchema` FNXC comment in packages/engine/src/agent-tools.ts) is a
 * nested object graph (nodes/edges/columns/...). Without this recursion any
 * nested `type:"object"` property fell through to the `default: z.unknown()`
 * branch below and the typed schema collapsed to `unknown` on the MCP wire —
 * defeating the whole point of discoverability. An object with NO declared
 * `properties` (a deliberately open bag, e.g. node `config`/`extensions`)
 * converts to `z.record(z.unknown())` rather than a rigid empty object so
 * forward-compatible fields are never rejected client-side.
 */
function jsonSchemaPropertyToZod(prop: Record<string, unknown>): ZodTypeAny {
  const enumValues = Array.isArray(prop.enum) ? (prop.enum as string[]) : undefined;
  if (enumValues && enumValues.length > 0) {
    return z.enum(enumValues as [string, ...string[]]).describe(typeof prop.description === "string" ? prop.description : "");
  }
  const description = typeof prop.description === "string" ? prop.description : "";
  switch (prop.type) {
    case "string": {
      let schema = z.string();
      if (typeof prop.minLength === "number" && Number.isFinite(prop.minLength)) schema = schema.min(prop.minLength);
      if (typeof prop.maxLength === "number" && Number.isFinite(prop.maxLength)) schema = schema.max(prop.maxLength);
      return schema.describe(description);
    }
    case "number": {
      // FNXC:McpServer 2026-07-16-19:35: FUSI-118 keeps registry-declared
      // text and pagination bounds at the shared Zod wire boundary for both
      // transports. Domain factories still own semantic/integer validation.
      let schema = z.number();
      if (typeof prop.minimum === "number" && Number.isFinite(prop.minimum)) schema = schema.min(prop.minimum);
      if (typeof prop.maximum === "number" && Number.isFinite(prop.maximum)) schema = schema.max(prop.maximum);
      return schema.describe(description);
    }
    case "boolean":
      return z.boolean().describe(description);
    case "array": {
      const items = prop.items as Record<string, unknown> | undefined;
      const itemSchema = items ? jsonSchemaPropertyToZod(items) : z.string();
      return z.array(itemSchema).describe(description);
    }
    case "object": {
      const properties = prop.properties as Record<string, unknown> | undefined;
      if (!properties || Object.keys(properties).length === 0) {
        // Open bag (e.g. node `config`/`extensions`) — keep permissive, not a rigid empty object.
        return z.record(z.string(), z.unknown()).describe(description);
      }
      const required = new Set(Array.isArray(prop.required) ? (prop.required as string[]) : []);
      const shape: Record<string, ZodTypeAny> = {};
      for (const [key, childProp] of Object.entries(properties)) {
        const zodType = jsonSchemaPropertyToZod(childProp as Record<string, unknown>);
        shape[key] = required.has(key) ? zodType : zodType.optional();
      }
      // .passthrough() so unknown forward-compatible keys survive validation —
      // authoritative validation stays server-side in the store.
      return z.object(shape).passthrough().describe(description);
    }
    default:
      return z.unknown().describe(description);
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
  /*
  FNXC:McpServer 2026-07-12-00:00:
  FUSI-083 optional launch-bound project identity, used to seed the session's
  "initial" project descriptor (see McpProjectSession). Kept OPTIONAL (never
  required) so existing test callers that only pass `{ cwd, store, version,
  allowDestructive }` keep compiling unchanged — falls back to `cwd`/
  `basename(cwd)` when omitted.
  */
  projectId?: string;
  projectName?: string;
}

export interface FusionMcpServer {
  server: McpServer;
  /** Connect the server to a transport (stdio in `fn mcp serve`, in-memory in tests). */
  connect: (transport: Transport) => Promise<void>;
  /*
  FNXC:McpServer 2026-07-12-00:00:
  FUSI-083: `close()` still does NOT close the INITIAL/launch-bound
  TaskStore — the caller (runMcpServe / a test) owns that lifecycle exactly
  as before. It DOES close any stores opened for a SWITCHED-TO project via
  `fn_project_use` (session/server-owned — see project-session.ts) so a
  session that visited other projects never leaks their SQLite handles.
  */
  close: () => Promise<void>;
  /** The session driving `fn_project_use`/`fn_project_current` for this server instance. */
  projectSession: McpProjectSession;
}

/**
 * Constructs an `McpServer` and registers every tool {@link buildMcpToolRegistry}
 * returns for the resolved `allowDestructive` flag. Does not create or own a
 * transport — callers (e.g. `runMcpServe` in packages/cli/src/commands/mcp.ts,
 * or a test) decide how to connect it. This keeps the seam open for a future
 * non-stdio transport without touching tool registration.
 */
export function buildMcpServer(options: BuildMcpServerOptions): FusionMcpServer {
  const { cwd, store, version, allowDestructive = false, projectId, projectName } = options;
  /*
  FNXC:McpProjectSession 2026-07-12-00:00:
  FUSI-083: one McpProjectSession per `buildMcpServer(...)` call, seeded
  with the launch-bound ("initial") project. Its store is CALLER-owned —
  this session never closes it (see the FNXC block on FusionMcpServer.close
  above and project-session.ts).
  */
  const projectSession = new McpProjectSession({
    projectId: projectId ?? cwd,
    projectName: projectName ?? basename(cwd),
    projectPath: cwd,
    store,
  });
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

  const runtimeCtx: McpToolRuntimeContext = { cwd, allowDestructive, projectSession };
  const registry = buildMcpToolRegistry(runtimeCtx);

  for (const tool of registry) {
    const inputShape = jsonSchemaToZodShape(tool.inputSchema);
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: inputShape },
      async (args) => {
        /*
        FNXC:McpServer 2026-07-12-00:00:
        FUSI-083 per-call active-project resolution seam. Every tool call
        re-reads `projectSession.current()` (rather than closing over the
        launch-bound `store`/`cwd` once) so a call made after `fn_project_use`
        dispatches against the SWITCHED-TO project's store/cwd, while a call
        made before any switch (or on a tool that ignores ctx.cwd, e.g. the
        fn_project_* CentralCore-driven tools) is unaffected. This is the
        single seam shared by both stdio and streamable-HTTP transports —
        neither owns transport-specific switch logic.
        */
        const active = projectSession.current();
        const callCtx: McpToolRuntimeContext = { ...runtimeCtx, cwd: active.projectPath };
        try {
          const result = await tool.handler(active.store, (args ?? {}) as Record<string, unknown>, callCtx);
          return result as never;
        } catch {
          // FNXC:McpServer 2026-07-16-19:35: FUSI-118 requires the common
          // registration loop to keep unexpected store/handler failures from
          // exposing stacks, database paths, or transport-specific details.
          return { content: [{ type: "text", text: "ERROR: Request could not be completed." }], isError: true } as never;
        }
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
    close: async () => {
      await server.close();
      await projectSession.close();
    },
    projectSession,
  };
}
