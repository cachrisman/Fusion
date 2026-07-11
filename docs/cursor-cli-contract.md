# Cursor CLI Contract (FN-3396 Step 0)

Date: 2026-05-07

<!--
FNXC:CursorCli 2026-07-08-00:00:
The original FN-3396 preflight assumed model discovery via JSON-flagged subcommand variants with a plain-text fallback, and stated no auth-status command was confirmed. FN-7697 captured and shipped the real `cursor-agent` CLI contract: model discovery is `cursor-agent models` (plain text `id - Label` lines, no JSON flag) and authentication is derived from `cursor-agent status --format json` (`isAuthenticated`). This doc was corrected on 2026-07-08 to match the verified contract; see FN-7697 for the implementation.
-->

**Update history:** 2026-07-08 — corrected the model-discovery and auth-status contract from FN-3396's assumed `--json` commands to the verified `cursor-agent models` / `cursor-agent status --format json` contract captured and implemented in FN-7697.

## Research method

- Local runtime inspection in the task environment (`which`, direct command execution).
- Local binary wrapper inspection (`cursor`, `cursor-agent` launch scripts and install layout).
- Bounded `fn_research_run` was attempted but failed in this environment with: `table research_runs has no column named projectId`.

## Confirmed invocation and binary detection

- **Primary executable aliases found on PATH:**
  - `cursor`
  - `cursor-agent`
- **Not found on PATH:**
  - `cursor-cli`
- `cursor` is a wrapper that can delegate to agent mode and emits a targeted message when IDE install is missing.
- `cursor-agent` is the direct CLI runtime entrypoint and is symlinked to a versioned install under:
  - `~/.local/share/cursor-agent/versions/<version>/cursor-agent`

### Detection strategy

1. If the global `cursorCliBinaryPath` setting is a non-empty string, probe that configured binary first.
2. Probe `cursor-agent` from PATH.
3. Probe `cursor` from PATH.
4. Deduplicate candidates when the configured value is exactly `cursor-agent` or `cursor`.
5. Persist the resolved path and executable name in probe results.
6. Report explicit failure reason when neither exists.

### Manual binary path override

<!--
FNXC:CursorCli 2026-07-02-00:00:
Operators can set a global Cursor CLI binary path when PATH discovery resolves the wrong shim. The override is optional and must never remove the cursor-agent/cursor fallback probes.
-->

Settings → Authentication → Cursor CLI exposes an optional binary path field. Leave it blank to use PATH auto-detection. When populated, Fusion validates the configured path by running the same `--version` probe used for status/enable, saves it only if that configured candidate itself succeeds, and then uses it for status, enable validation, and Cursor model discovery before falling back to PATH candidates.

If the configured path fails during ordinary status/model-discovery probes but a PATH candidate succeeds, Fusion remains usable and reports the PATH candidate as the effective `binaryPath`; bounded diagnostics include the configured-path failure. If saving a new non-empty override fails or only succeeds via PATH fallback, the Settings save returns a 400 diagnostic and does not persist the path.

Windows paths with spaces, for example `C:\Users\A User\AppData\Roaming\npm\cursor-agent.cmd`, are treated as one operator-provided string. Users should not quote or split the path in the UI.

### Windows PATH shim invocation

<!--
FNXC:CursorCli 2026-07-02-00:00:
Windows Cursor installs may publish `cursor-agent.cmd`, `cursor.cmd`, or equivalent `.bat` shims on PATH; Fusion must invoke Cursor probe and discovery commands through the Windows shell so Node can execute those wrappers.
Unix and macOS stay direct-spawned to avoid broadening shell semantics beyond the platform that requires it.
-->

On Windows, `cursor-agent`, `cursor`, and manual override paths can resolve to `.cmd` / `.bat` wrappers rather than native executables. Node.js direct `spawn(binary, args)` does not execute those wrappers reliably; Fusion's Cursor command runner therefore sets shell execution only when `process.platform === "win32"`.

The Windows shell-backed path applies to every Cursor CLI command Fusion currently runs through the shared runner:

- Configured binary / `cursor-agent --version` / `cursor --version` probe attempts.
- Auth-status probe against the effective probe-selected binary: `cursor-agent status --format json`.
- Model discovery against the effective probe-selected binary: `cursor-agent models` (plain text, no `--json` flag).

Non-Windows probes and discovery continue to use direct spawn. Spawn errors such as `ENOENT` or `EACCES` are included in the unavailable probe reason in bounded diagnostic form so a working terminal command is distinguishable from known Cursor runtime/auth states; Fusion does not dump PATH, environment variables, or unbounded stdout/stderr.

## Confirmed error/auth/runtime signals

Observed command behavior in this environment:

- `cursor --help` (without IDE install):
  - `Error: No Cursor IDE installation found. Use 'cursor agent' or 'agent' to run the agent.`
- `cursor-agent --help` and `cursor agent --help` (with locked keychain):
  - `Error: Your macOS login keychain is locked.`
  - `Run security unlock-keychain and try again.`

### Auth/readiness implications

- Keychain-locked is a distinct, expected failure mode and must be surfaced as an auth/runtime-blocked state (not as unknown crash).
- Missing IDE install is a distinct expected failure mode from missing binary.

## Structured output and model discovery

- **Confirmed:** `cursor-agent models` is the model-list command. Output is plain text — passing an unsupported JSON output flag (e.g. appending `--json` to the `models` subcommand) fails with `error: unknown option '--json'`.
- Output shape: an `Available models` header line, a blank line, then one model per line formatted as `<id> - <Label>` (e.g. `auto - Auto (default)`, `claude-4.5-sonnet - Sonnet 4.5`), followed by a trailing tip line: `Tip: use --model <id> (or /model <id> in interactive mode) to switch.`.
- Empty-account state: `No models available for this account.` (no model lines follow).
- `cursor-agent --list-models` exists but is unreliable — it can report "No models available for this account." even while the CLI is authenticated with models available. Prefer `cursor-agent models`.

### Model discovery parsing strategy (implemented)

1. Run `cursor-agent models` (or the effective probe-selected binary) with a short timeout.
2. Split stdout into lines; extract the bare model id as the segment before the first ` - ` on each line.
3. Filter out the `Available models` header, the trailing `Tip:` line, the `No models available for this account.` empty-state line, and blank lines.
4. Normalize and dedupe the remaining ids into the discovered model set.
5. If the command is unavailable or fails, return an empty discovered set with a machine-readable reason; host surfaces Cursor models only when provider readiness + discovery usability conditions are met.

### Authentication / status

- **Confirmed:** authentication state is derived from `cursor-agent status --format json` (alias `whoami`), which returns a JSON object with `isAuthenticated` (boolean), plus `status`, `hasAccessToken`, and `userInfo`.
- Use `isAuthenticated` as the auth signal instead of treating a successful `--version` probe as a proxy for readiness. `--version` remains the availability/version probe (bare version string), separate from auth.
- Keychain-locked and missing-IDE-install remain distinct expected failure modes on top of this (see "Confirmed error/auth/runtime signals" above) — a locked keychain or missing IDE surfaces as its own runtime-blocked state rather than folding into `isAuthenticated: false`.

## Provider ID decision

- Use **`cursor-cli`** as the provider ID.
- Rationale: aligns with task requirement; no conflicting provider ID observed in current codebase scan.
- FUSI-069: this plugin (`cliProviders[0]`, `providerId: "cursor-cli"`) only DECLARES the provider/probe/discovery contract described in this document; registering `cursor-cli` into the engine's execution `ModelRegistry` (so a `cursor-cli/<id>` task selection actually resolves) and routing that selection to this plugin's `CursorRuntimeAdapter` runtime is the responsibility of the engine's plugin-cliProviders bridge (`registerExtensionProviders` in `packages/engine/src/pi.ts`, plus the `cursor-cli` -> `cursor` runtime derivation in `packages/engine/src/agent-session-helpers.ts`). See `docs/settings-reference.md` ("Grok"/"Cursor" provider paragraphs) for the operator-facing behavior.

## Contract freeze for FN-3396 (superseded by the verified contract below)

The original FN-3396 preflight treated the following as canonical pending stronger evidence:

- Binary candidates: `cursor-agent`, `cursor`.
- Expected failure states include: missing binary, missing IDE installation, keychain locked, unauthenticated/not-ready CLI.
- Model discovery must be dynamic-first with resilient fallback and no hardcoded static catalog by default.

Binary candidates and expected failure states above remain accurate. The dynamic-first/no-static-catalog principle also still holds, but the specific commands are now confirmed rather than assumed — see "Structured output and model discovery" and "Windows PATH shim invocation" above for the verified `cursor-agent models` / `cursor-agent status --format json` contract that replaces the earlier `--json`-flag guesswork.

## Execution / streaming contract

<!--
FNXC:CursorCli 2026-07-11-00:00:
FUSI-063 implemented `CursorRuntimeAdapter.promptWithFallback()`, the last stub in the FN-3396/FN-7695..7700/FUSI-050 cursor-agent integration track. Everything below was captured live against a real `cursor-agent` binary (spec capture at v2026.07.08-0c04a8a, re-verified live at v2026.07.09-a3815c0 during implementation) — see `plugins/fusion-plugin-cursor-runtime/src/execution-process-manager.ts`, `stream-parser.ts`, and `runtime-adapter.ts` for the implementation.
-->

This section covers the headless execution contract used to run a full agentic turn through `cursor-agent`, as opposed to the probe/discovery/auth commands documented above.

### Headless invocation

Fusion delegates the entire agentic loop to `cursor-agent` (it has its own write/shell tools) rather than treating it as a raw text-completion provider — the same runtime-delegation model already used for the Droid CLI runtime. The confirmed invocation is:

```
cursor-agent -p --output-format stream-json --force --trust --workspace <cwd> --model <id> [--resume <chatId>] [--mode plan|ask] [--add-dir <path> ...] [--approve-mcps] "<prompt>"
```

Relevant flags (from `cursor-agent -p --help`, confirmed live):

- `-p, --print` — required for non-interactive/scripted execution; grants the agent access to all tools including write and shell.
- `--output-format stream-json` — emit one NDJSON event per line on stdout (only valid with `--print`).
- `--stream-partial-output` — (not currently used by Fusion) would stream partial assistant text deltas instead of whole-block `assistant` events; omitted today because live capture showed cursor-agent emits full assistant text per block without it.
- `--force` / `--yolo` (alias) — force-allow commands unless explicitly denied. Fusion always passes `--force` since the task worktree is already sandboxed/scoped by Fusion itself.
- `--trust` — trust the current workspace without an interactive prompt (only valid with `--print`/headless mode); required for non-interactive execution.
- `--workspace <path>` — the working directory. Fusion always sets this to the task's cwd and NEVER passes cursor-agent's own `-w`/`--worktree` flag, which would have cursor-agent create a SEPARATE isolated worktree under `~/.cursor/worktrees/<reponame>/<name>` — Fusion already owns worktree isolation.
- `--model <id>` — accepts bracketed parameter overrides, e.g. `'claude-opus-4-8[context=1m,effort=high,fast=false]'`; Fusion passes the bare discovered/configured model id. Falls back to cursor-agent's own built-in `auto` alias only when no model id was configured (not a Fusion-side static catalog — confirmed live: an unmodeled invocation's `system`/`init` event reports `"model":"Auto"`).
- `--resume [chatId]` / `--continue` / `create-chat` — session continuation. Fusion resumes a prior turn by passing `--resume <sessionId>`, where `sessionId` is captured off the previous turn's `system`/`result` event `session_id` field. `cursor-agent create-chat` (prints a bare chat id and exits) exists to pre-allocate a chat id up front but is not required for the common case — cursor-agent mints a session id itself on the first turn.
- `--mode plan|ask` — read-only lanes. `plan`: read-only/planning (analyze, propose plans, no edits). `ask`: Q&A style for explanations and questions (read-only). Fusion passes `--mode plan` for `tools:"readonly"` sessions and omits the flag entirely for the default full-edit agent lane.
- `--add-dir <path>` — repeatable; adds an additional workspace root directory beyond `--workspace`. Passed through when the caller supplies extra roots.
- `--approve-mcps` — automatically approve all forwarded MCP servers. Passed through when MCP servers are forwarded to the session.

### NDJSON event stream

Five event shapes were confirmed via live capture of `cursor-agent -p --output-format stream-json ... "Say the word PONG and nothing else."`:

1. **`system`/`init`** — first event of every stream:
   ```json
   {"type":"system","subtype":"init","apiKeySource":"login","cwd":"/private/tmp/cursor-scratch","session_id":"771e1505-...","model":"Auto","permissionMode":"default"}
   ```
2. **`user`** — echoes the received prompt: `message.content[]` is an array of `{type:"text", text}` blocks.
3. **`thinking`** — `subtype:"delta"` carries incremental reasoning `text`; `subtype:"completed"` closes the block (no `text` field). Multiple `delta` events arrive per turn.
4. **`assistant`** — final assistant message; `message.content[]` is an array of `{type:"text", text}` blocks. Live capture showed cursor-agent emits WHOLE text per block by default (not incremental deltas) unless `--stream-partial-output` is passed.
5. **`result`** — terminal event of the stream:
   ```json
   {"type":"result","subtype":"success","duration_ms":4313,"duration_api_ms":4313,"is_error":false,"result":"PONG","session_id":"771e1505-...","request_id":"12b3f589-...","usage":{"inputTokens":11322,"outputTokens":39,"cacheReadTokens":5941,"cacheWriteTokens":0}}
   ```
   `is_error:true` means the turn failed; Fusion routes this into its existing fallback path (rejects the prompt promise) rather than silently resolving as success. `usage` field names (`inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`) are cursor-agent's own casing, distinct from Fusion's internal `TaskTokenUsage` (`inputTokens`/`outputTokens`/`cachedTokens`/`cacheWriteTokens`/`totalTokens`) — Fusion maps field-by-field rather than assuming identical shape.

Malformed/unrecognized NDJSON lines (including non-JSON diagnostic lines such as `cursor-retrieval: tracing to '<tmp log path>'`, which live capture confirmed are written to STDERR, never interleaved into the stdout NDJSON stream) are skipped rather than thrown — one bad line never kills the rest of the parse loop.

### Security: diagnostics never reach the protocol channel

Same rule as probe/discovery (see "Windows PATH shim invocation" above): cursor-agent's stderr output is captured into a bounded buffer for diagnostics-only logging (attached only to a thrown error message on stream failure), never written to the MCP/stdout protocol channel, and Fusion never dumps PATH, environment variables, or unbounded stdout/stderr.

### Abort handling

When the caller supplies an `AbortSignal`, an abort kills the child process (`SIGTERM` first, then an escalated `SIGKILL` after a bounded grace period if the process hasn't exited — mirroring the timeout-kill pattern already used for probe/discovery commands) and rejects the pending prompt promise cleanly rather than leaking the subprocess.

### Completion handshake: delegated terminal-success replaces `fn_task_done`

<!--
FNXC:DelegatedRuntimeCompletion 2026-07-12-00:35:
FUSI-071 closed the final gap in the cursor CLI chain (FUSI-063 adapter + FUSI-069 registry bridge + FUSI-070 runtime auto-install): the executor's completion protocol ("did the agent call fn_task_done?") is specific to Fusion's own pi/Claude tool-bearing sessions. `cursor-agent` runs its own self-contained agentic loop and does not carry Fusion's injected tools, so it can never call `fn_task_done`.
-->

Fusion's executor completion gate normally waits for the agent to call the Fusion-injected `fn_task_done` tool. `cursor-agent` (like `droid`/`grok` and other delegated CLI runtimes) does not carry that tool — it runs its own self-contained write/shell agentic loop end-to-end. For any resolved runtime that is not the default pi runtime or the scripted mock runtime (`isDelegatedCliRuntime()` in `packages/engine/src/runtime-resolution.ts`), the runtime's OWN terminal signal replaces `fn_task_done`:

- **Terminal success** (`promptWithFallback` resolves without throwing — i.e. a `result` event with `is_error:false`) is treated as an implicit `fn_task_done` call on the FIRST session. The executor never enters its "Agent finished without calling fn_task_done — retrying with new session" loop for a delegated runtime; that retry loop remains exactly as-is for pi/Claude/mock sessions, which genuinely call the tool.
- **Terminal error** (`promptWithFallback` rejects — i.e. `result.is_error:true`, or the process exits/aborts before emitting a `result` event) flows through the executor's existing error/failure handling and marks the task `status:"failed"` with the cursor error surfaced. It is never silently retried as a missing-`fn_task_done` case.
- **Token usage**: the terminal `result.usage` (mapped to `CursorTaskTokenUsage` by `mapUsage()` in `runtime-adapter.ts`) is threaded back through `AgentPromptResult.usage` (the pi.ts `promptWithFallback` dispatcher now returns the runtime's result instead of discarding it) and captured into `task.tokenUsage` by `applyDelegatedRuntimeUsage()` (`packages/engine/src/session-token-usage.ts`) — these sessions don't implement `getSessionStats()`, so the pi-native `accumulateSessionTokenUsage()` baseline-diff seam is a no-op for them.
- **Model marker**: `createResolvedAgentSession` attaches the resolved runtime's own `describeModel` on the session (mirroring the existing `promptWithFallback` dispatch attach) for any non-default runtime, so the `Executor using model: …` log line reports `cursor/<model>` instead of the misleading `undefined/undefined` that resulted from reading the pi-native `session.model.provider`/`.id` shape against a plain string model.

**Update history:** 2026-07-11 — FUSI-063 implemented the execution adapter (`CursorRuntimeAdapter.promptWithFallback`/`createSession`/`describeModel`) using the contract documented in this section, closing out the FN-3396/FN-7695..7700/FUSI-050 cursor-agent integration track. 2026-07-12 — FUSI-071 documented the delegated-runtime completion handshake (terminal-success as implicit `fn_task_done`, terminal-error as a real failure, usage capture, model-marker fix) generically for cursor/droid/grok and future delegated CLI plugin runtimes.
