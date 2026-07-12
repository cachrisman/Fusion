/* eslint-disable @typescript-eslint/no-explicit-any */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ResolvedMcpServerDefinition } from "@fusion/core";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHttpMcpTransport, describeMcpOAuthError, type McpOAuthTokenStore } from "./mcp-oauth-provider.js";

export interface McpSessionToolset {
  tools: ToolDefinition[];
  dispose: () => Promise<void>;
  connected: string[];
  skipped: Array<{ name: string; reason: string }>;
}

export interface McpSessionClient {
  connect(transport: Transport): Promise<void>;
  listTools(): Promise<{ tools?: McpToolMetadata[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }, resultSchema?: unknown, options?: { signal?: AbortSignal }): Promise<McpToolCallResult>;
  close(): Promise<void>;
}

export interface McpToolMetadata {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolCallResult {
  content?: unknown[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

export type McpClientFactory = (server: ResolvedMcpServerDefinition) => McpSessionClient;
export type McpTransportFactory = (
  server: ResolvedMcpServerDefinition,
  opts: { cwd?: string; oauthTokenStore?: McpOAuthTokenStore; logger?: Pick<Console, "log" | "warn"> },
) => Transport;

export interface McpSessionToolsOptions {
  cwd?: string;
  signal?: AbortSignal;
  clientFactory?: McpClientFactory;
  transportFactory?: McpTransportFactory;
  logger?: Pick<Console, "log" | "warn">;
  closeTimeoutMs?: number;
  /** Injected OAuth token writeback seam (secret-ref persistence); see mcp-oauth-provider.ts. */
  oauthTokenStore?: McpOAuthTokenStore;
}

const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;

/*
 * FNXC:McpConfig 2026-06-27-13:55:
 * Pi does not consume `mcpServers` natively, so Fusion must run the MCP handshake in the engine and expose discovered tools through pi customTools. MCP definitions can contain materialized secret env vars, args, URLs, and headers; logs from this module stay content-free and include only server names, transports, tool counts, and sanitized error messages.
 *
 * FNXC:McpConfig 2026-06-27-14:18:
 * MCP tool names are globally visible inside the pi session. Generate deterministic `mcp__<server>__<tool>` names and suffix sanitizer collisions so an MCP server can never shadow built-ins/fn_* tools or another server's advertised tool.
 *
 * FNXC:McpConfig 2026-06-27-14:43:
 * Preserve each MCP tool input schema when registering pi customTools so providers see required arguments. Connection logs use coarse error categories instead of raw MCP exception messages because spawned server args/env/header/url values can carry secrets.
 */
export async function connectMcpSessionTools(
  servers: ResolvedMcpServerDefinition[],
  opts: McpSessionToolsOptions = {},
): Promise<McpSessionToolset> {
  const tools: ToolDefinition[] = [];
  const connected: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const clients: McpSessionClient[] = [];
  const usedToolNames = new Set<string>();
  let disposed = false;

  const closeAll = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await Promise.allSettled(clients.map((client) => closeClient(client, opts.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS)));
  };

  const onAbort = (): void => {
    void closeAll();
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    for (const server of servers) {
      if (server.enabled === false) {
        skipped.push({ name: server.name, reason: "disabled" });
        continue;
      }
      if (opts.signal?.aborted) {
        skipped.push({ name: server.name, reason: "aborted" });
        break;
      }
      const client = (opts.clientFactory ?? defaultClientFactory)(server);
      let didConnect = false;
      try {
        const transport = (opts.transportFactory ?? defaultTransportFactory)(server, {
          cwd: opts.cwd,
          oauthTokenStore: opts.oauthTokenStore,
          logger: opts.logger,
        });
        await client.connect(transport);
        didConnect = true;
        clients.push(client);
        const listed = await client.listTools();
        connected.push(server.name);
        const listedTools = listed.tools ?? [];
        opts.logger?.log?.(`MCP server connected for pi session: name=${server.name} transport=${server.transport} tools=${listedTools.length}`);
        for (const tool of listedTools) {
          tools.push(wrapMcpTool(server.name, tool, client, usedToolNames));
        }
      } catch (error) {
        const reason = describeMcpOAuthError(error) ?? safeErrorReason(error);
        skipped.push({ name: server.name, reason });
        opts.logger?.warn?.(`Skipping MCP server for pi session: name=${server.name} transport=${server.transport} reason=${reason}`);
        if (didConnect) {
          await closeClient(client, opts.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS);
        }
      }
    }
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    if (opts.signal?.aborted) {
      await closeAll();
    }
  }

  return { tools, connected, skipped, dispose: closeAll };
}

function defaultClientFactory(): McpSessionClient {
  return new Client({ name: "fusion-pi-mcp-session", version: "0.1.0" }, { capabilities: {} }) as unknown as McpSessionClient;
}

function defaultTransportFactory(
  server: ResolvedMcpServerDefinition,
  opts: { cwd?: string; oauthTokenStore?: McpOAuthTokenStore; logger?: Pick<Console, "log" | "warn"> },
): Transport {
  if (server.transport === "stdio") {
    // FNXC:McpConfig 2026-07-12-00:00: stdio is a local transport and is never extended with OAuth (FUSI-073/074) —
    // no authProvider wiring applies here, only the HTTP-family transports below go through the shared helper.
    return new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: { ...process.env, ...(server.env ?? {}) } as Record<string, string>,
      cwd: opts.cwd,
      stderr: "pipe",
    });
  }
  return createHttpMcpTransport(server, { tokenStore: opts.oauthTokenStore, logger: opts.logger });
}

function wrapMcpTool(
  serverName: string,
  tool: McpToolMetadata,
  client: McpSessionClient,
  usedToolNames: Set<string>,
): ToolDefinition {
  const name = uniqueMcpToolName(serverName, tool.name, usedToolNames);
  return {
    name,
    label: tool.title ?? tool.name,
    description: tool.description ?? `MCP tool ${tool.name} from ${serverName}`,
    parameters: mcpInputSchemaToParameters(tool.inputSchema),
    execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal): Promise<any> => {
      try {
        const result = await client.callTool(
          { name: tool.name, arguments: isRecord(params) ? params : {} },
          undefined,
          signal ? { signal } : undefined,
        );
        return {
          content: mapMcpContent(result),
          details: result.structuredContent ? { structuredContent: result.structuredContent } : {},
          isError: result.isError === true,
        };
      } catch (error) {
        const message = safeErrorReason(error);
        return {
          content: [{ type: "text" as const, text: `MCP tool ${tool.name} failed: ${message}` }],
          details: {},
          isError: true,
        };
      }
    },
  };
}

export function uniqueMcpToolName(serverName: string, toolName: string, usedToolNames = new Set<string>()): string {
  const base = `mcp__${sanitizeToolSegment(serverName)}__${sanitizeToolSegment(toolName)}`;
  let candidate = base;
  let suffix = 2;
  while (usedToolNames.has(candidate)) {
    candidate = `${base}__${suffix}`;
    suffix += 1;
  }
  usedToolNames.add(candidate);
  return candidate;
}

function sanitizeToolSegment(value: string): string {
  const sanitized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").replace(/_+/g, "_");
  return sanitized || "unnamed";
}

function mapMcpContent(result: McpToolCallResult): AgentToolResult<unknown>["content"] {
  if (Array.isArray(result.content) && result.content.length > 0) {
    return result.content.map((entry) => {
      if (isRecord(entry) && entry.type === "text" && typeof entry.text === "string") {
        return { type: "text" as const, text: entry.text };
      }
      if (isRecord(entry) && entry.type === "image" && typeof entry.data === "string" && typeof entry.mimeType === "string") {
        return { type: "image" as const, data: entry.data, mimeType: entry.mimeType };
      }
      return { type: "text" as const, text: JSON.stringify(entry) };
    });
  }
  if (result.structuredContent) {
    return [{ type: "text" as const, text: JSON.stringify(result.structuredContent) }];
  }
  if ("toolResult" in result) {
    return [{ type: "text" as const, text: JSON.stringify(result.toolResult) }];
  }
  return [{ type: "text" as const, text: "" }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mcpInputSchemaToParameters(inputSchema: Record<string, unknown> | undefined): any {
  if (!inputSchema || !isRecord(inputSchema)) {
    return Type.Object({}, { additionalProperties: true });
  }

  const type = typeof inputSchema.type === "string" ? inputSchema.type : undefined;
  if (type === "object" || inputSchema.properties || inputSchema.required) {
    return {
      type: "object",
      properties: isRecord(inputSchema.properties) ? inputSchema.properties : {},
      ...(Array.isArray(inputSchema.required) ? { required: inputSchema.required.filter((value) => typeof value === "string") } : {}),
      additionalProperties: inputSchema.additionalProperties ?? true,
      ...(typeof inputSchema.description === "string" ? { description: inputSchema.description } : {}),
    };
  }

  return Type.Object({}, { additionalProperties: true });
}

function safeErrorReason(error: unknown): string {
  if (error instanceof Error) {
    return error.name && error.name !== "Error" ? error.name : "error";
  }
  return typeof error;
}

async function closeClient(client: McpSessionClient, timeoutMs: number): Promise<void> {
  await Promise.race([
    client.close().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
