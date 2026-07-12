import type {
  GlobalSettings,
  McpOAuthAuth,
  McpSecretRef,
  McpServerDefinition,
  McpServersSettings,
  McpStdioTransport,
  McpSseTransport,
  McpStreamableHttpTransport,
  ProjectSettings,
} from "./types.js";
import { isMcpSecretRef } from "./types.js";
import type { SecretScope } from "./secrets-store.js";
import { validateMcpServerDefinition } from "./settings-validation.js";

export interface McpSecretImportDescriptor {
  serverName: string;
  field: "env" | "headers" | "token";
  key: string;
  scope: SecretScope;
  suggestedKey: string;
  plaintextValue: string;
}

export interface McpServersImportResult {
  definitions: McpServerDefinition[];
  secretsToCreate: McpSecretImportDescriptor[];
  errors: string[];
}

export type McpSecretReaderIdentity = { agentId?: string | null; userId?: string | null };

export interface McpSecretReader {
  revealSecret(
    id: string,
    scope: SecretScope,
    reader: McpSecretReaderIdentity,
  ): Promise<{ key: string; plaintextValue: string }>;
}

export interface ResolvedMcpStdioTransport extends Omit<McpStdioTransport, "env"> {
  env?: Record<string, string>;
}

/**
 * FNXC:McpConfig 2026-07-12-00:00:
 * Resolved (materialized) oauth auth shape mirrors McpOAuthAuth but with credential-bearing fields (clientSecret/accessToken/refreshToken) resolved to plain runtime strings. Non-secret fields (authorizationServerUrl/clientId/scopes/redirectUrl/expiresAt) pass through unchanged. This shape only ever exists transiently at the use seam — never persisted.
 */
export interface ResolvedMcpOAuthAuth extends Omit<McpOAuthAuth, "clientSecret" | "accessToken" | "refreshToken"> {
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
}

export interface ResolvedMcpSseTransport extends Omit<McpSseTransport, "headers" | "auth"> {
  headers?: Record<string, string>;
  auth?: ResolvedMcpOAuthAuth;
}

export interface ResolvedMcpStreamableHttpTransport extends Omit<McpStreamableHttpTransport, "headers" | "auth"> {
  headers?: Record<string, string>;
  auth?: ResolvedMcpOAuthAuth;
}

export type ResolvedMcpServerDefinition = {
  name: string;
  enabled?: boolean;
} & (ResolvedMcpStdioTransport | ResolvedMcpSseTransport | ResolvedMcpStreamableHttpTransport);

export interface McpSecretResolutionError {
  serverName: string;
  path: string;
  secretRef: McpSecretRef;
  message: string;
}

export interface McpSecretResolutionResult<T> {
  value?: T;
  errors: McpSecretResolutionError[];
}

function normalizeMcpServersSettings(settings?: McpServersSettings): McpServersSettings {
  return {
    enabled: settings?.enabled === true,
    servers: Array.isArray(settings?.servers) ? settings.servers : [],
  };
}

function validServers(settings?: McpServersSettings): McpServerDefinition[] {
  return (
    normalizeMcpServersSettings(settings).servers
      ?.map(validateMcpServerDefinition)
      .filter((server): server is McpServerDefinition => Boolean(server)) ?? []
  );
}

/**
 * FNXC:McpConfig 2026-06-25-00:00:
 * Effective MCP configuration is project-over-global by server name. A project server with enabled:false removes the inherited global declaration, while a project enabled declaration replaces it. The resolver is pure and never throws so settings reads cannot break task scheduling.
 */
export function resolveEffectiveMcpServers(
  globalSettings?: Pick<GlobalSettings, "mcpServers"> | null,
  projectSettings?: Pick<ProjectSettings, "mcpServers"> | null,
): McpServerDefinition[] {
  try {
    const globalMcp = normalizeMcpServersSettings(globalSettings?.mcpServers);
    const projectMcp = projectSettings?.mcpServers;
    const effectiveEnabled = typeof projectMcp?.enabled === "boolean" ? projectMcp.enabled : globalMcp.enabled;
    if (!effectiveEnabled) return [];

    const byName = new Map<string, McpServerDefinition>();
    for (const server of validServers(globalSettings?.mcpServers)) {
      if (server.enabled === false) continue;
      byName.set(server.name, server);
    }
    for (const server of validServers(projectMcp)) {
      if (server.enabled === false) {
        byName.delete(server.name);
        continue;
      }
      byName.set(server.name, server);
    }
    return [...byName.values()].filter((server) => server.enabled !== false);
  } catch {
    return [];
  }
}

async function materializeSensitiveMap(params: {
  serverName: string;
  path: string;
  values?: Record<string, McpSecretRef | string>;
  secrets: McpSecretReader;
  reader: McpSecretReaderIdentity;
}): Promise<McpSecretResolutionResult<Record<string, string> | undefined>> {
  const { values, secrets, reader, serverName, path } = params;
  if (!values) return { value: undefined, errors: [] };
  const resolved: Record<string, string> = {};
  const errors: McpSecretResolutionError[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!isMcpSecretRef(value)) {
      errors.push({
        serverName,
        path: `${path}.${key}`,
        secretRef: { secretRef: "", scope: "project" },
        message: "MCP sensitive values must be secret references; plaintext was not materialized",
      });
      continue;
    }
    try {
      const revealed = await secrets.revealSecret(value.secretRef, value.scope, reader);
      resolved[key] = revealed.plaintextValue;
    } catch (error) {
      errors.push({
        serverName,
        path: `${path}.${key}`,
        secretRef: value,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { value: Object.keys(resolved).length > 0 ? resolved : undefined, errors };
}

/**
 * FNXC:McpConfig 2026-07-12-00:00:
 * Materializes a single sensitive oauth field (clientSecret/accessToken/refreshToken) via the injected revealSecret reader, mirroring materializeSensitiveMap's per-entry resolution but for a scalar field. Reuses the same fail-soft contract: a resolution failure is reported as a McpSecretResolutionError and the field is omitted, never logged or returned unresolved.
 */
async function materializeSensitiveValue(params: {
  serverName: string;
  path: string;
  value?: McpSecretRef | string;
  secrets: McpSecretReader;
  reader: McpSecretReaderIdentity;
}): Promise<McpSecretResolutionResult<string | undefined>> {
  const { value, secrets, reader, serverName, path } = params;
  if (value === undefined) return { value: undefined, errors: [] };
  if (!isMcpSecretRef(value)) {
    return {
      errors: [
        {
          serverName,
          path,
          secretRef: { secretRef: "", scope: "project" },
          message: "MCP sensitive values must be secret references; plaintext was not materialized",
        },
      ],
    };
  }
  try {
    const revealed = await secrets.revealSecret(value.secretRef, value.scope, reader);
    return { value: revealed.plaintextValue, errors: [] };
  } catch (error) {
    return {
      value: undefined,
      errors: [
        {
          serverName,
          path,
          secretRef: value,
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

/**
 * FNXC:McpConfig 2026-07-12-00:00:
 * Materializes the optional oauth auth variant on HTTP-family transports: clientSecret/accessToken/refreshToken are resolved through the injected secret reader (same fail-soft contract as materializeSensitiveMap), while authorizationServerUrl/clientId/scopes/redirectUrl/expiresAt pass through unchanged. Returns undefined when the server has no auth block (no-auth path unaffected).
 */
async function materializeMcpOAuthAuth(params: {
  serverName: string;
  auth?: McpOAuthAuth;
  secrets: McpSecretReader;
  reader: McpSecretReaderIdentity;
}): Promise<McpSecretResolutionResult<ResolvedMcpOAuthAuth | undefined>> {
  const { serverName, auth, secrets, reader } = params;
  if (!auth) return { value: undefined, errors: [] };
  const clientSecret = await materializeSensitiveValue({
    serverName,
    path: "auth.clientSecret",
    value: auth.clientSecret,
    secrets,
    reader,
  });
  const accessToken = await materializeSensitiveValue({
    serverName,
    path: "auth.accessToken",
    value: auth.accessToken,
    secrets,
    reader,
  });
  const refreshToken = await materializeSensitiveValue({
    serverName,
    path: "auth.refreshToken",
    value: auth.refreshToken,
    secrets,
    reader,
  });
  const errors = [...clientSecret.errors, ...accessToken.errors, ...refreshToken.errors];
  return {
    value: {
      type: "oauth",
      authorizationServerUrl: auth.authorizationServerUrl,
      ...(auth.clientId !== undefined ? { clientId: auth.clientId } : {}),
      ...(clientSecret.value !== undefined ? { clientSecret: clientSecret.value } : {}),
      ...(auth.scopes ? { scopes: auth.scopes } : {}),
      ...(auth.redirectUrl !== undefined ? { redirectUrl: auth.redirectUrl } : {}),
      ...(accessToken.value !== undefined ? { accessToken: accessToken.value } : {}),
      ...(refreshToken.value !== undefined ? { refreshToken: refreshToken.value } : {}),
      ...(auth.expiresAt !== undefined ? { expiresAt: auth.expiresAt } : {}),
    },
    errors,
  };
}

/**
 * FNXC:McpConfig 2026-06-25-00:00:
 * MCP secret materialization happens only at the use seam by calling the injected SecretsStore-compatible revealSecret method. Failed references are reported and omitted; the function never logs or returns unresolved secret material as plaintext.
 */
export async function materializeMcpServerSecrets(
  server: McpServerDefinition,
  secrets: McpSecretReader,
  reader: McpSecretReaderIdentity,
): Promise<McpSecretResolutionResult<ResolvedMcpServerDefinition>> {
  if (server.transport === "stdio") {
    const env = await materializeSensitiveMap({
      serverName: server.name,
      path: "env",
      values: server.env,
      secrets,
      reader,
    });
    return {
      value: {
        name: server.name,
        ...(server.enabled !== undefined ? { enabled: server.enabled } : {}),
        transport: "stdio",
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
        ...(env.value ? { env: env.value } : {}),
      },
      errors: env.errors,
    };
  }

  const headers = await materializeSensitiveMap({
    serverName: server.name,
    path: "headers",
    values: server.headers,
    secrets,
    reader,
  });
  const auth = await materializeMcpOAuthAuth({
    serverName: server.name,
    auth: server.auth,
    secrets,
    reader,
  });
  return {
    value: {
      name: server.name,
      ...(server.enabled !== undefined ? { enabled: server.enabled } : {}),
      transport: server.transport,
      url: server.url,
      ...(headers.value ? { headers: headers.value } : {}),
      ...(auth.value ? { auth: auth.value } : {}),
    },
    errors: [...headers.errors, ...auth.errors],
  };
}

export async function materializeMcpServersSecrets(
  servers: McpServerDefinition[],
  secrets: McpSecretReader,
  reader: McpSecretReaderIdentity,
): Promise<McpSecretResolutionResult<ResolvedMcpServerDefinition[]>> {
  const values: ResolvedMcpServerDefinition[] = [];
  const errors: McpSecretResolutionError[] = [];
  for (const server of servers) {
    const resolved = await materializeMcpServerSecrets(server, secrets, reader);
    if (resolved.value) values.push(resolved.value);
    errors.push(...resolved.errors);
  }
  return { value: values, errors };
}

function parseMcpJson(json: string | unknown): { data?: unknown; error?: string } {
  if (typeof json !== "string") return { data: json };
  try {
    return { data: JSON.parse(json) as unknown };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function suggestedSecretKey(serverName: string, field: "env" | "headers" | "token", key: string): string {
  const clean = (value: string): string => value.trim().replace(/[^A-Za-z0-9_.-]+/gu, "_").replace(/^_+|_+$/gu, "");
  return ["mcp", clean(serverName), clean(field), clean(key)].filter(Boolean).join(".");
}

function importSensitiveMap(params: {
  value: unknown;
  serverName: string;
  field: "env" | "headers";
  scope: SecretScope;
  secretsToCreate: McpSecretImportDescriptor[];
  errors: string[];
}): Record<string, McpSecretRef> | undefined {
  const { value, serverName, field, scope, secretsToCreate, errors } = params;
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${serverName}.${field} must be an object`);
    return undefined;
  }
  const out: Record<string, McpSecretRef> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (isMcpSecretRef(raw)) {
      out[key] = { secretRef: raw.secretRef.trim(), scope: raw.scope };
      continue;
    }
    if (typeof raw === "string") {
      const secretRef = suggestedSecretKey(serverName, field, key);
      out[key] = { secretRef, scope };
      secretsToCreate.push({
        serverName,
        field,
        key,
        scope,
        suggestedKey: secretRef,
        plaintextValue: raw,
      });
      continue;
    }
    errors.push(`${serverName}.${field}.${key} must be a string or MCP secret reference`);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Import Claude Desktop-style `{ mcpServers: { [name]: ... } }` JSON into Fusion
 * definitions. Plain env/header strings are surfaced as secret creation
 * descriptors and replaced with secret references; plaintext is never stored in
 * the returned definitions.
 */
export function importMcpServersJson(json: string | unknown, options: { scope?: SecretScope } = {}): McpServersImportResult {
  const parsed = parseMcpJson(json);
  if (parsed.error) return { definitions: [], secretsToCreate: [], errors: [parsed.error] };
  const errors: string[] = [];
  const secretsToCreate: McpSecretImportDescriptor[] = [];
  const scope = options.scope ?? "project";
  const root = parsed.data;
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return { definitions: [], secretsToCreate, errors: ["MCP import data must be an object"] };
  }
  const servers = (root as Record<string, unknown>).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return { definitions: [], secretsToCreate, errors: ["MCP import data must contain an mcpServers object"] };
  }

  const definitions: McpServerDefinition[] = [];
  const names = new Set<string>();
  for (const [name, rawServer] of Object.entries(servers as Record<string, unknown>)) {
    if (!rawServer || typeof rawServer !== "object" || Array.isArray(rawServer)) {
      errors.push(`${name} must be an object`);
      continue;
    }
    const raw = rawServer as Record<string, unknown>;
    const enabled = typeof raw.enabled === "boolean" ? raw.enabled : undefined;
    const base = { name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : name, ...(enabled !== undefined ? { enabled } : {}) };
    const transport = typeof raw.transport === "string" ? raw.transport : typeof raw.command === "string" ? "stdio" : undefined;
    let candidate: McpServerDefinition | undefined;
    if (transport === "stdio") {
      candidate = validateMcpServerDefinition({
        ...base,
        transport: "stdio",
        command: raw.command,
        args: raw.args,
        env: importSensitiveMap({ value: raw.env, serverName: base.name, field: "env", scope, secretsToCreate, errors }),
      });
    } else if (transport === "sse" || transport === "streamable-http") {
      candidate = validateMcpServerDefinition({
        ...base,
        transport,
        url: raw.url,
        headers: importSensitiveMap({ value: raw.headers, serverName: base.name, field: "headers", scope, secretsToCreate, errors }),
        // FNXC:McpConfig 2026-07-12-00:00: Phase 1 import passes an already-secret-ref `auth` block straight through validation
        // (round-trip preservation). Authorize-time plaintext token/DCR handling is Phase 3 scope, not implemented here.
        ...(raw.auth !== undefined ? { auth: raw.auth } : {}),
      });
    } else {
      errors.push(`${name}.transport must be stdio, sse, or streamable-http`);
    }
    if (!candidate) {
      errors.push(`${name} is not a valid MCP server definition`);
      continue;
    }
    if (names.has(candidate.name)) {
      errors.push(`Duplicate MCP server name: ${candidate.name}`);
      continue;
    }
    names.add(candidate.name);
    definitions.push(candidate);
  }
  return { definitions, secretsToCreate, errors };
}

function exportSensitiveMap(values: Record<string, McpSecretRef | string> | undefined): Record<string, McpSecretRef> | undefined {
  if (!values) return undefined;
  const out: Record<string, McpSecretRef> = {};
  for (const [key, value] of Object.entries(values)) {
    if (isMcpSecretRef(value)) out[key] = { secretRef: value.secretRef, scope: value.scope };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Export Fusion MCP definitions as JSON-safe `mcpServers` data with secret refs preserved and never resolved. */
export function exportMcpServersJson(definitions: McpServerDefinition[]): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {};
  for (const definition of definitions) {
    const server = validateMcpServerDefinition(definition);
    if (!server) continue;
    if (server.transport === "stdio") {
      mcpServers[server.name] = {
        transport: "stdio",
        ...(server.enabled !== undefined ? { enabled: server.enabled } : {}),
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
        ...(server.env ? { env: exportSensitiveMap(server.env) } : {}),
      };
      continue;
    }
    if (server.auth) {
      mcpServers[server.name] = {
        transport: server.transport,
        ...(server.enabled !== undefined ? { enabled: server.enabled } : {}),
        url: server.url,
        ...(server.headers ? { headers: exportSensitiveMap(server.headers) } : {}),
        auth: server.auth,
      };
      continue;
    }
    mcpServers[server.name] = {
      transport: server.transport,
      ...(server.enabled !== undefined ? { enabled: server.enabled } : {}),
      url: server.url,
      ...(server.headers ? { headers: exportSensitiveMap(server.headers) } : {}),
    };
  }
  return { mcpServers };
}
