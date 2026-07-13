# Grok CLI Contract (FN-7790, updated by FN-7796)

Date: 2026-07-10

<!--
FNXC:GrokCli 2026-07-10-12:58:
FN-7796 supersedes FN-7790's streaming assumption. Operators run xAI's official Grok Build TUI (`grok 0.2.93`); its `--output-format streaming-json` path intermittently ends `stopReason:"Cancelled"` with zero `text` events, so Fusion's reliable headless prompt path invokes `grok -p <prompt> --output-format json` and parses the single `{text,stopReason,sessionId,requestId,thought}` object. A non-`EndTurn` stop reason with empty text is a concrete diagnostic, never a silent no-message response.
# Grok CLI Contract (FN-7790 / FN-7796, updated for ACP transport)

Date: 2026-07-11

<!--
FNXC:GrokAcp 2026-07-11-12:00:
Agent session transport is native ACP (`grok agent stdio`) for realtime
session/update streaming, tool visibility, multi-turn session reuse, and Fusion
permission-gate integration. The previous one-shot `grok -p --output-format json`
path is retired as the primary prompt transport because it buffered until
subprocess close and could not surface tool calls. Probe (`grok --version`) and
model discovery (`grok models`) are unchanged.

-->

## Ground truth

Fusion shells out to an **operator-installed** `grok` binary. The binary is not downloaded or bundled by Fusion, so the authoritative contract is the installed xAI CLI's own help/version output plus live execution on an authenticated machine.

External integration evidence:

- Canonical upstream: xAI official Grok CLI / Grok Build TUI, surfaced by the installed binary as `grok 0.2.93 (f00f96316d4b)`.
- Docs/homepage: https://grok.com/, https://docs.x.ai/, and `grok --help` / `grok agent --help` for exact flags.
- Docs/homepage: https://grok.com/, https://docs.x.ai/, https://docs.x.ai/build/overview, and `grok --help` / `grok agent --help` / `grok agent stdio --help` for exact flags.
- ACP protocol: https://agentclientprotocol.com

- Release/download: operator-installed; Fusion resolves `grok` from PATH or `grokCliBinaryPath` and does not bundle a release artifact.
- Binary name: `grok`.
- Checksum: `upstream-pending-verification` because Fusion does not pin or download the operator's binary.

The previously documented https://github.com/superagent-ai/grok-cli contract is a different product that happens to use the same binary name. Its `grok --prompt <text> --format json` invocation is not accepted by xAI's CLI.

## Failures that shaped the contract

### Wrong-product flags (FN-7790)

The old adapter invocation fails against the real xAI binary:

```bash
grok --prompt "say hello" --format json
```

Observed result:

```text
exit 2
stdout: <empty>
stderr:
error: unexpected argument '--prompt' found

  tip: a similar argument exists: '--prompt-file'

Usage: grok --prompt-file <PATH> [PROMPT]
```

Because no renderable assistant text is produced, Fusion surfaced a blank/no-message assistant response.

### Streaming JSON cancellation with zero text (FN-7796)

FN-7790 correctly switched to xAI's real flags and streaming event union, but live triage found `--output-format streaming-json` is intermittently unreliable. The same authenticated `grok 0.2.93` binary sometimes emits only reasoning events, then ends with `stopReason:"Cancelled"` and no `text` event while still exiting 0 with empty stderr.

Live-captured shape:

```jsonl
{"type":"thought","data":"..."}
{"type":"thought","data":"..."}
{"type":"end","stopReason":"Cancelled","sessionId":"...","requestId":"..."}
```

The adapter previously saw parsed events and a successful close, accumulated empty assistant text, set no error, and produced a silent no-message bubble. The reliable replacement is the single-object JSON contract below.

## Confirmed non-interactive invocation used by Fusion

Use xAI Grok Build TUI's single-turn prompt mode with **single-object JSON**:

```bash
grok -p "<text>" --output-format json
# equivalent long prompt flag:
grok --single "<text>" --output-format json
```

Supported companion flags used by Fusion:

- `-p, --single <PROMPT>` — run a single prompt, print the response, and exit. This does not require interactive stdin.
- `--output-format <plain|json|streaming-json>` — Fusion uses `json` for reliable headless prompts.
- `-m, --model <MODEL>` — optional concrete model id. Fusion omits this for the model-less `grok/default` Runtime-mode path.
- `--cwd <CWD>` — optional working directory. This replaces the wrong-product `--directory` flag.

Other observed flags include `--prompt-file <PATH>`, `--prompt-json <JSON>`, `-s/--session-id <UUID>`, `--sandbox <PROFILE>`, `--system-prompt-override <PROMPT>`, and `--max-turns <N>`, but Fusion's adapter does not currently use them.

## Reliable JSON response schema

`--output-format json` emits one final JSON object rather than an NDJSON stream. Observed shape:

```ts
interface GrokJsonResponse {
  text?: string;
  stopReason?: string;
  sessionId?: string;
  requestId?: string;
  thought?: string;
}
```

Example:

```json
{
  "text": "Hello",
  "stopReason": "EndTurn",
  "sessionId": "019f4d81-8fb1-7f11-98ca-5ae00654b518",
  "requestId": "bb7952e2-f1bc-4574-b409-5cc568817fe5",
  "thought": "The user wants me to say hello in one word..."
}
```

Mapping in Fusion:

- `thought` → `onThinking(thought)` when non-empty.
- `text` → `onText(text)` and accumulated assistant content when non-empty.
- `sessionId` → `session.sessionId` when present.
- subprocess `close` remains the authoritative promise resolution point because it carries exit status/stderr diagnostics.

Live reliability evidence from FN-7796: `grok -p "say hello in one word" --output-format json` returned real text with `stopReason:"EndTurn"` on 4/4 direct runs, and the built `GrokRuntimeAdapter` carried real text through `onText`/persisted assistant content on 3/3 end-to-end runs against the real binary.

## Streaming JSON event schema (not the primary prompt path)

`--output-format streaming-json` emits one JSON object per line:

```ts
type GrokStreamingJsonEvent =
  | { type: "thought"; data: string }
  | { type: "text"; data: string }
  | { type: "end"; stopReason?: string; sessionId?: string; requestId?: string };
```

Successful captured tail:

```jsonl
{"type":"thought","data":" one"}
{"type":"thought","data":"-"}
{"type":"thought","data":"word"}
{"type":"thought","data":" greeting"}
{"type":"thought","data":"."}
{"type":"text","data":"Hello"}
{"type":"text","data":"!"}
{"type":"end","stopReason":"EndTurn","sessionId":"019f4d1e-2582-70e0-a174-c8774782ab01","requestId":"2233f1dc-e9ad-4ae4-8221-caa6afade07f"}
```

Fusion does not use streaming-json as the primary headless prompt path because it intermittently produces the cancelled/no-text shape documented above. Parser support remains only to keep diagnostics and regression tests concrete if captured streaming output appears in buffered stdout.

## Other output formats

`--output-format plain` prints renderable response text, but does not expose `sessionId`, `requestId`, `stopReason`, or `thought`.

## Model discovery

`grok models` is plain text, not JSON. Observed shape:

```text
You are logged in with grok.com.

Default model: grok-4.5

Available models:
  * grok-4.5 (default)
  - grok-composer-2.5-fast
```

Fusion parses the bullet list conservatively and exposes ids under provider `grok-cli` when the `useGrokCli` toggle is enabled.

## Auth and readiness

The CLI owns authentication for CLI-routed execution. Fusion's readiness probe uses `grok --version`; a passing probe proves only that a compatible-looking binary exists, not that the prompt path is authenticated or serviceable. The prompt path is proven by a real `grok -p ... --output-format json` run.

Fusion-visible `GROK_API_KEY` remains relevant for the direct xAI OpenAI-compatible endpoint. For CLI-routed sessions, Fusion does not need to see a key as long as the operator-installed CLI is authenticated by its own supported mechanism.

## Runtime routing

The Grok runtime adapter is reached when:

1. an agent explicitly sets `runtimeConfig.runtimeHint === "grok"`; or
2. the FN-7753/FN-7758 no-visible-key fallback derives the same runtime hint for a `grok-cli/*` default/fallback provider selection and the bundled Grok Runtime plugin is registered.

The selected `grok-cli/<id>` or `grok/<id>` model is normalized to `<id>` and passed to the CLI as `-m <id>`. The explicit no-model Runtime-mode path keeps `grok/default` and omits `-m`.

## Diagnostics and empty-output invariant

The adapter preserves the resolve-never-reject runtime contract while surfacing concrete diagnostics:

- spawn failure → `session.state.errorMessage` and diagnostic `onText`.
- non-zero subprocess close with no text → stderr/exit diagnostic.
- code-0 close with no parseable JSON response → wrong-binary/interactive-EOF diagnostic.
- parseable response with no text and `stopReason !== "EndTurn"` → stop-reason diagnostic, e.g. `Grok CLI ended with stopReason Cancelled and produced no assistant text.`
- parseable `EndTurn` response with no assistant text → legitimate silent response, not a diagnostic.
- text emitted before a noisy/non-zero close → keep the assistant text and avoid replacing it with an error.

This invariant prevents the original blank/no-message symptom while still allowing genuinely empty model turns.
## Agent session transport — ACP (`grok agent stdio`)

Fusion's `GrokRuntimeAdapter` drives Grok as an ACP (Agent Client Protocol) agent over JSON-RPC/stdio, following [xAI Headless & Scripting](https://docs.x.ai/build/cli/headless-scripting#acp):

```bash
# Official automation shape (docs.x.ai): suppress update checks in CI/scripts
grok --no-auto-update agent stdio
# with optional model + session skills plugin:
grok --no-auto-update agent --plugin-dir <session-plugin> -m grok-4.5 stdio
```

ACP session lifecycle (official contract):

1. `initialize` (protocolVersion 1)
2. **`authenticate`** — prefer `xai.api_key` when `XAI_API_KEY` is set and advertised, else `cached_token`, with `_meta: { headless: true }`
3. `session/new` (cwd, mcpServers, optional `_meta.pluginDirs` / rules)
4. `session/prompt` — completion metadata on the response; assistant text arrives as `session/update` `agent_message_chunk`s

Auth: local `grok login` (cached token in `~/.grok/auth.json`) **or** `XAI_API_KEY`. Fusion forwards `XAI_API_KEY` on the spawn allow-list.

Implementation uses a **vendored** ACP client under `plugins/fusion-plugin-grok-runtime/src/acp/` (copied from the ACP runtime plugin; not a package import) with Grok-specific settings:

| Setting | Grok value |
| --- | --- |
| Binary | `grok` (or configured path) |
| Args | `["agent", "--plugin-dir", "<session-plugin>", …, "stdio"]` (optional `-m <id>`) |
| Env | Allow-list including `HOME`/`PATH`/`USER`/XDG + optional `XAI_API_KEY`/`GROK_API_KEY` (never full `process.env`) |
| `acpFsRead` / `acpFsWrite` | `false` (Grok has native tools; client-side fs stays off) |
| `acpAllowUnrestricted` | `true` (operator-selected first-party CLI; non-allow policy categories still gated) |
| `session/new.mcpServers` | Operator MCP servers (stdio/http/sse) + Fusion `fusion-custom-tools` bridge for `fn_*` |
| Skills | Session-scoped Grok plugin (`--plugin-dir` + `_meta.pluginDirs`) with bundled Fusion skill + `additionalSkillPaths` |

### Fusion tools and skills

<!--
FNXC:GrokAcp 2026-07-11-14:00:
Parity with pi sessions: executor/chat lanes pass customTools + skillSelection +
mcpServers through createResolvedAgentSession. Grok ACP must not drop them.
-->

1. **Operator MCP** — `options.mcpServers` is reshaped to ACP wire format and forwarded on `session/new`.
2. **Fusion custom tools (`fn_*`)** — engine `customTools` are hosted by a loopback HTTP bridge + stdio MCP server (`mcp-schema-server.cjs`) named `fusion-custom-tools`. Grok invokes tools via real MCP `tools/call`; the bridge runs `ToolDefinition.execute` in-process.
3. **Skills** — the bundled Fusion skill (`packages/cli/skill/fusion`) plus any `additionalSkillPaths` skill roots are staged into a temp plugin directory and loaded via `grok agent --plugin-dir` and `_meta.pluginDirs`. Requested skill names and tool counts are also written into `_meta.rules` / system prompt context.

### Session lifecycle

1. `createSession` — spawn `grok agent stdio`, ACP `initialize`, `session/new` over the task cwd.
2. `promptWithFallback` — ACP `session/prompt` with text + optional chat image ContentBlocks from prompt options; stream `session/update` notifications until terminal `stopReason`.
3. `dispose` — best-effort `session/cancel` + process-registry SIGKILL (authoritative no-orphan guarantee).

### Streamed update mapping

| ACP `sessionUpdate` | Fusion callback |
| --- | --- |
| `agent_message_chunk` | `onText` |
| `agent_thought_chunk` | `onThinking` |
| `tool_call` | `onToolStart` |
| `tool_call_update` (terminal) | `onToolEnd` |

Multi-turn conversations reuse the same ACP session/connection (no cold spawn per prompt).

### Auth

Grok owns authentication. Preferred path is a cached session in `~/.grok/auth.json` (requires `HOME` in the allow-list). Optional key-based auth uses `XAI_API_KEY` or `GROK_API_KEY` when no cached token is present. The readiness probe (`grok --version`) proves only binary presence, not authenticated ACP readiness.

### Permissions

Tool calls from the Grok agent surface as ACP `session/request_permission` and route through Fusion's per-category action gate (same floor as the generic ACP runtime). Unrestricted policy + `acpAllowUnrestricted` auto-allows sensitive categories for autonomous executor turns; `require-approval` / `block` still apply when configured.

## Failures that shaped the prior headless contract (historical)

### Wrong-product flags (FN-7790)

The old adapter invocation fails against the real xAI binary:

```bash
grok --prompt "say hello" --format json
```

### Streaming JSON cancellation with zero text (FN-7796)

`--output-format streaming-json` intermittently ended `stopReason:"Cancelled"` with zero `text` events. That motivated the temporary switch to single-object `--output-format json`. ACP replaces both headless modes for agent sessions because it streams reliably over JSON-RPC and carries tool/permission structure.

## Probe and model discovery (unchanged)

### Version probe

```bash
grok --version
```

### Model discovery

`grok models` is plain text, not JSON. Observed shape:

```text
You are logged in with grok.com.

Default model: grok-4.5

Available models:
  * grok-4.5 (default)
  - grok-composer-2.5-fast
```

Fusion parses the bullet list conservatively and exposes ids under provider `grok-cli` when the `useGrokCli` toggle is enabled.

## Runtime routing

The Grok runtime adapter is reached when:

1. an agent explicitly sets `runtimeConfig.runtimeHint === "grok"`; or
2. the FN-7753/FN-7758 no-visible-key fallback derives the same runtime hint for a `grok-cli/*` default/fallback provider selection and the bundled Grok Runtime plugin is registered.

The selected `grok-cli/<id>` or `grok/<id>` model is normalized to `<id>` and passed as `grok agent -m <id> stdio`. The explicit no-model Runtime-mode path keeps `grok/default` and omits `-m`.

## Diagnostics and empty-output invariant

The adapter preserves the resolve-never-reject runtime contract while surfacing concrete diagnostics:

- ACP create/handshake failure → dead session + diagnostic `onText` (create does not throw to the engine).
- ACP prompt failure → diagnostic `onText` when no assistant text streamed; never reject.
- Abnormal `stopReason` (not `end_turn`) with zero text → stop-reason diagnostic.
- Clean `end_turn` with no assistant text → legitimate silent response, not a diagnostic.
- Partial text before a failed close → keep the assistant text; do not replace it with an error.

This invariant prevents blank/no-message assistant bubbles while still allowing genuinely empty model turns.

