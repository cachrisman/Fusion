import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  OLLAMA_ENDPOINT_AUTH_PROVIDER_ID,
  resolveGlobalDirForHome,
  resolveOllamaEndpointAuthToken,
  resolveOllamaSettings,
  type OllamaSettings,
} from "@fusion/core";
import { createFusionAuthStorage } from "./auth-storage.js";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type StreamOptions } from "@earendil-works/pi-ai";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";

export const OLLAMA_PROVIDER_ID = "ollama";
/** Unique because pi-ai dispatch registration is process-global (FUSI-090). */
export const OLLAMA_NATIVE_API_ID = "fusion-ollama-native";

interface ModelRegistryLike {
  registerProvider: (name: string, config: { baseUrl: string; api: string; apiKey?: string; models: Array<{ id: string; name: string; reasoning: boolean; input: ("text" | "image")[]; cost: { input: number; output: number; cacheRead: number; cacheWrite: number }; contextWindow: number; maxTokens: number }> }) => void;
  refresh?: () => void;
}

/** Reads only the persisted named native setting; never examines customProviders. */
export function readNativeOllamaSettings(homeDir = homedir()): OllamaSettings {
  try {
    const raw = readFileSync(join(resolveGlobalDirForHome(homeDir), "settings.json"), "utf-8");
    return resolveOllamaSettings((JSON.parse(raw) as { ollama?: OllamaSettings }).ollama);
  } catch { return resolveOllamaSettings(undefined); }
}

/*
FNXC:OllamaProvider 2026-07-15-00:00:
FUSI-099 requires dashboard seed, save-time validation, and runtime registries
all expose the same `ollama/<id>` identities. FUSI-090 proved pi API dispatch
is process-global, so this dedicated API id must never be `openai-completions`.
*/
export function registerNativeOllamaProvider(modelRegistry: ModelRegistryLike, settings: OllamaSettings): void {
  if (!settings.enabled || settings.models.length === 0) return;
  const seen = new Set<string>();
  const models = settings.models.filter((model) => model.id && !seen.has(model.id) && (seen.add(model.id), true)).map((model) => ({
    id: model.id, name: model.name || model.id, reasoning: settings.think, input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: settings.numCtx, maxTokens: settings.numCtx,
  }));
  if (!models.length) return;
  /*
  FNXC:OllamaEndpointAuth 2026-07-15-00:00:
  pi-ai validates models-bearing registry providers require an `apiKey` shape.
  `ollama-native` satisfies only that SDK schema; it is neither a stored
  operator credential nor an outbound header. Real endpoint auth is resolved
  separately from protected auth storage immediately before native `/api/chat`.
  */
  modelRegistry.registerProvider(OLLAMA_PROVIDER_ID, { baseUrl: settings.endpoint, api: OLLAMA_NATIVE_API_ID, apiKey: "ollama-native", models });
  modelRegistry.refresh?.();
}

export function isNativeOllamaModel(provider: string | undefined): boolean { return provider === OLLAMA_PROVIDER_ID; }

type NativeMessage = { role: "system" | "user" | "assistant" | "tool"; content: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> };
function nativeMessages(context: Context): NativeMessage[] {
  const result: NativeMessage[] = context.systemPrompt ? [{ role: "system", content: context.systemPrompt }] : [];
  for (const message of context.messages) {
    if (message.role === "user") result.push({ role: "user", content: typeof message.content === "string" ? message.content : message.content.map((part) => part.type === "text" ? part.text : "").join("") });
    else if (message.role === "toolResult") result.push({ role: "tool", content: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") });
    else result.push({ role: "assistant", content: message.content.filter((part) => part.type === "text").map((part) => part.text).join(""), ...(message.content.some((part) => part.type === "toolCall") ? { tool_calls: message.content.filter((part) => part.type === "toolCall").map((part) => ({ function: { name: part.name, arguments: part.arguments } })) } : {}) });
  }
  return result;
}
function nativeTools(context: Context) { return context.tools?.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } })); }

export async function readNativeOllamaEndpointAuthToken(endpoint: string): Promise<string | undefined> {
  try {
    const stored = await createFusionAuthStorage().getApiKey(OLLAMA_ENDPOINT_AUTH_PROVIDER_ID);
    return resolveOllamaEndpointAuthToken(stored, endpoint);
  } catch {
    // Endpoint auth is optional: unavailable credential storage must not block local Ollama.
    return undefined;
  }
}

/**
 * FNXC:OllamaEndpointAuth 2026-07-15-00:00:
 * The endpoint-bound auth-storage value is resolved against `model.baseUrl`
 * before header composition. This protects active sessions retaining an older
 * model URL while Settings switches endpoints: a token for the new URL must
 * never cross to the old native chat request.
 */
export function nativeOllamaRequestHeaders(headers: StreamOptions["headers"] | undefined, endpointAuthToken: string | undefined): Record<string, string> {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value === "string") result.set(name, value);
  }
  result.set("Content-Type", "application/json");
  result.delete("Authorization");
  if (endpointAuthToken) result.set("Authorization", `Bearer ${endpointAuthToken}`);
  return Object.fromEntries(result.entries());
}

/** FNXC:OllamaNativeStream 2026-07-15-00:00: Native Ollama uses `/api/chat`, `think:false`, and `num_ctx:32768`; never route through OpenAI compatibility. */
export function streamNativeOllama(model: Model<string>, context: Context, options?: StreamOptions) {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const settings = readNativeOllamaSettings();
    const output: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
    try {
      let payload: unknown = { model: model.id, messages: nativeMessages(context), ...(nativeTools(context) ? { tools: nativeTools(context) } : {}), stream: true, think: settings.think, options: { num_ctx: settings.numCtx } };
      payload = (await options?.onPayload?.(payload, model)) ?? payload;
      const endpointAuthToken = await readNativeOllamaEndpointAuthToken(model.baseUrl);
      const response = await fetch(`${model.baseUrl.replace(/\/+$/, "")}/api/chat`, { method: "POST", headers: nativeOllamaRequestHeaders(options?.headers, endpointAuthToken), body: JSON.stringify(payload), signal: options?.signal });
      await options?.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers.entries()) }, model);
      if (!response.ok || !response.body) throw new Error(`Ollama returned HTTP ${response.status}`);
      stream.push({ type: "start", partial: output }); const decoder = new TextDecoder(); let pending = ""; let textStarted = false;
      for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) { pending += decoder.decode(bytes, { stream: true }); const lines = pending.split("\n"); pending = lines.pop() ?? ""; for (const line of lines) { if (!line.trim()) continue; let chunk: { message?: { content?: unknown; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: Record<string, unknown> } }> }; done?: boolean; model?: string; prompt_eval_count?: number; eval_count?: number; done_reason?: string }; try { chunk = JSON.parse(line) as typeof chunk; } catch { throw new Error("Ollama returned malformed NDJSON"); } const content = chunk.message?.content; if (typeof content === "string" && content) { if (!textStarted) { output.content.push({ type: "text", text: "" }); stream.push({ type: "text_start", contentIndex: 0, partial: output }); textStarted = true; } const block = output.content[0] as { type: "text"; text: string }; block.text += content; stream.push({ type: "text_delta", contentIndex: 0, delta: content, partial: output }); } for (const call of chunk.message?.tool_calls ?? []) { const index = output.content.length; const toolCall = { type: "toolCall" as const, id: call.id ?? `ollama-${index}`, name: call.function?.name ?? "unknown", arguments: call.function?.arguments ?? {} }; output.content.push(toolCall); stream.push({ type: "toolcall_start", contentIndex: index, partial: output }); stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output }); } if (chunk.done) { output.responseModel = chunk.model; output.usage.input = chunk.prompt_eval_count ?? 0; output.usage.output = chunk.eval_count ?? 0; output.usage.totalTokens = output.usage.input + output.usage.output; output.stopReason = output.content.some((part) => part.type === "toolCall") ? "toolUse" : chunk.done_reason === "length" ? "length" : "stop"; stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output }); return; } } }
      throw new Error("Ollama stream ended without a terminal response");
    } catch (error) { output.stopReason = options?.signal?.aborted ? "aborted" : "error"; output.errorMessage = error instanceof Error ? error.message : "Ollama request failed"; stream.push({ type: "error", reason: output.stopReason, error: output }); }
  })(); return stream;
}
export function registerNativeOllamaApiProvider(): void { registerApiProvider({ api: OLLAMA_NATIVE_API_ID, stream: streamNativeOllama, streamSimple: streamNativeOllama }); }

export function assertNativeOllamaExecutorAllowed(provider: string | undefined, modelId: string | undefined, settings: Partial<{ ollama?: OllamaSettings }>): void {
  if (!isNativeOllamaModel(provider)) return;
  const ollama = resolveOllamaSettings(settings.ollama);
  const model = ollama.models.find((entry) => entry.id === modelId);
  if (!ollama.executorEnabled || !model?.toolCallingVerified) {
    throw new Error(`Ollama executor model '${modelId ?? "unknown"}' requires the global executor opt-in and verified native tools capability`);
  }
}
