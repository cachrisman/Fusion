# MCP (Model Context Protocol)

[← Back to docs index](./README.md)

MCP (Model Context Protocol) is a standard way to attach external tool servers to AI runtimes. Fusion stores trusted MCP server definitions in settings, resolves the effective global/project configuration, materializes any referenced secrets only at use time, and forwards enabled servers to MCP-capable AI lanes so those lanes can use the same operator-approved tools.

<!--
FNXC:McpDocs 2026-06-26-00:00:
This page is the canonical MCP operator guide. Keep CLI flags, settings keys, validation statuses, and dashboard section names aligned with the shipped MCP code so secret-reference behavior is documented once without duplicating full procedures across adjacent docs.
-->

## Overview

MCP support lets Fusion operators configure external stdio, SSE, or streamable HTTP MCP servers once and make them available to AI sessions that support MCP. Enabled servers are treated as **trusted once configured**: after an operator saves a server definition, Fusion may forward it to supported AI lanes without asking again for each session.

MCP configuration lives in the `mcpServers` settings key at both scopes:

- **Global settings** hold shared MCP declarations.
- **Project settings** hold project-specific declarations.
- Effective resolution is project-over-global by server `name`: global servers load first, same-named project servers replace them, and same-named project servers with `enabled:false` disable the inherited global server.
- The project-level `mcpServers.enabled` flag overrides the global flag when it is set. If the effective flag is false, no MCP servers are active.

Expected outcome: when `mcpServers.enabled` resolves to true and at least one enabled server definition is valid, supported AI runtimes receive the effective server set for new sessions.

## Server definitions and transports

Every server has a unique `name`, an optional per-server `enabled` flag, and exactly one transport:

| Transport | Required fields | Optional sensitive fields | Notes |
|---|---|---|---|
| `stdio` | `command` | `env` | `args` may provide command arguments. |
| `sse` | `url` | `headers` | Uses an SSE endpoint. |
| `streamable-http` | `url` | `headers` | The CLI also accepts `http` as an alias and stores `streamable-http`. |

Definitions use these shapes:

```json
{ "name": "local-tools", "enabled": true, "transport": "stdio", "command": "node", "args": ["server.js"], "env": { "API_KEY": { "secretRef": "sec_...", "scope": "project" } } }
{ "name": "docs-sse", "transport": "sse", "url": "https://example.test/sse", "headers": { "Authorization": { "secretRef": "sec_...", "scope": "global" } } }
{ "name": "docs-http", "transport": "streamable-http", "url": "https://example.test/mcp", "headers": { "Authorization": { "secretRef": "sec_...", "scope": "project" } } }
```

Expected outcome: settings validation accepts only the required fields for the selected transport, rejects duplicate server names within one stored settings array, and rejects plaintext sensitive values.

## Secret references

Fusion never persists raw MCP environment values, header values, or token-like material in settings. Sensitive maps store only Fusion-managed secret references:

```json
{ "secretRef": "sec_...", "scope": "project" }
```

Use `scope: "project"` for secrets stored in the current project and `scope: "global"` for secrets stored in the global secrets database. The plaintext value lives in the encrypted [Secrets](./secrets.md) store, not in `mcpServers`.

Fusion materializes MCP secret references only at the use seam:

- when creating an AI session for an MCP-capable runtime;
- when running a bounded validation/reachability probe;
- when importing plaintext Claude Desktop env/header values and immediately creating Fusion secrets.

<!-- FNXC:McpConfig 2026-06-26-17:06: FN-7078 extended the FN-7077 forwarding invariant to dashboard readonly planning helpers. Configured MCP servers must reach subtask breakdown (stream/retry/triage), text refinement, goal drafting, agent onboarding generation, PR metadata generation, and insight extraction whenever those helpers have a scoped TaskStore; terminal sessions and DB-row chat session creation remain non-agent-runtime surfaces and intentionally receive no MCP payload. -->
MCP-capable AI sessions include Chat, planning, executor/Tasks, heartbeat runs, reviewer/validator/merger lanes, PR-response and PR-conflict merger helpers, manual AI-prompt workflow steps, workflow model nodes, evaluator, cron/automation, mission execution, mission and milestone/slice interviews, agent reflection, and dashboard readonly planning helpers such as subtask breakdown, text refinement/goal drafting, agent onboarding generation, PR metadata generation, and insight extraction. Non-agent runtime surfaces such as terminal sessions and `chatStore.createSession` database row creation do not receive MCP servers.

Expected outcome: API responses, CLI output, settings JSON, exports, and structured logs show secret references or counts/status metadata only; they do not include decrypted env/header values.

## Validation and reachability

The dashboard **Test** control calls `POST /api/mcp/validate` for one server. The route accepts a JSON body with either:

- `name` — resolve a configured server by name in the current project context; or
- `server` / `definition` — validate and probe the supplied server definition.

`timeoutMs` is optional, must be positive, and is capped at 30000 milliseconds. The response is:

```json
{ "status": "valid", "message": "..." }
```

`status` is one of:

| Status | Meaning |
|---|---|
| `valid` | The definition resolved, secrets materialized, and the bounded probe reached the server. |
| `unreachable` | The definition resolved, but the probe could not reach the server within the bounded check. |
| `error` | Validation, secret resolution, spawn, fetch, or protocol setup failed. |

Expected outcome: validation returns only `{ status, message? }`; resolved `env` and `headers` values are never returned.

Note: `fn mcp validate` currently validates stored definitions and reports whether they satisfy Fusion's schema. It does not perform the dashboard/API reachability probe.

## Managing servers in the dashboard

1. Open **Settings → Global → MCP Servers** for shared defaults, or **Settings → Project → MCP Servers** for project-specific servers. Expected outcome: the **Global MCP servers** or **Project MCP servers** card appears.
2. Turn on **Enable MCP servers for this scope**. Expected outcome: the current scope's `mcpServers.enabled` draft becomes true; project scope overrides global enablement when saved.
3. Click **Add server**. Choose `stdio`, `SSE`, or `HTTP`, then enter the required `command` or `url`. Expected outcome: the editor only asks for fields used by that transport and saves `HTTP` as `streamable-http`.
4. Add sensitive values under **Environment secret refs** for `stdio` or **Header secret refs** for `sse` / `streamable-http`. Choose an existing secret or create a new secret with **Create secret**. Expected outcome: the settings draft receives only `{ secretRef, scope }`; the plaintext creation value is stored in Secrets, not in settings.
5. Save the server. Expected outcome: the row appears with its transport, state badge, and validation status of **Not tested**.
6. In project settings, review inherited rows from global settings. Use **Override** to replace an inherited server or **Disable** to add a same-named project disabled entry. Expected outcome: state badges identify inherited, overridden, project-local, and disabled-global behavior before you save.
7. Click **Test** on a server row. Expected outcome: the row shows **Testing…** while pending, then `valid`, `unreachable`, or `error` with the returned message.
8. Review **Discovered on this machine**. Expected outcome: Fusion shows read-only MCP servers found in supported third-party config files for this scope, with source labels and a **Configured** badge for same-named servers already present in the current settings draft.
9. Click **Add** for a discovered server you trust. Expected outcome: servers without sensitive fields are copied into the current scope and enable that scope; servers with discovered env/header/token material open the editor so you bind existing Fusion secrets or create new Fusion secrets before saving.
10. Use the **Import** pane to paste JSON or choose **Upload JSON**. Expected outcome: Claude Desktop-style servers are added to the draft, duplicate names are rejected, and plaintext env/header values are converted into newly created Fusion secrets plus secret references.
11. Use **Copy Fusion MCP JSON** and then **Download JSON** when needed. Expected outcome: the export contains Fusion MCP JSON with secret references, and no plaintext secret values.
12. Save the Settings modal. Expected outcome: the selected global or project `mcpServers` settings are persisted and used by subsequent MCP-capable AI sessions.

## Auto-discovering MCP servers

Fusion can scan known on-host MCP configuration files and show inert candidates in **Settings → Global → MCP Servers** and **Settings → Project → MCP Servers**. Discovery is read-only: Fusion does not auto-enable, spawn, validate, connect to, or otherwise execute a discovered server. A discovered server becomes trusted only after an operator clicks **Add**, reviews the definition, binds any required secrets, and saves Settings.

The scanner reads only these well-known paths; missing files are normal and malformed files produce non-fatal notes in the card:

| Tool | Scope | macOS / Linux path | Windows path |
|---|---|---|---|
| Claude Desktop | Global | macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`; Linux: `~/.config/Claude/claude_desktop_config.json` | `%APPDATA%\\Claude\\claude_desktop_config.json` |
| Claude Code | Global | `~/.claude.json` | `%USERPROFILE%\\.claude.json` |
| Cursor | Global | `~/.cursor/mcp.json` | `%USERPROFILE%\\.cursor\\mcp.json` |
| Windsurf | Global | `~/.codeium/windsurf/mcp_config.json` | `%USERPROFILE%\\.codeium\\windsurf\\mcp_config.json` |
| Cursor | Project | `<projectRootDir>/.cursor/mcp.json` | `<projectRootDir>\\.cursor\\mcp.json` |
| VS Code | Project | `<projectRootDir>/.vscode/mcp.json` | `<projectRootDir>\\.vscode\\mcp.json` |

Claude Desktop, Claude Code, Cursor, and Windsurf use the Claude-style `{ "mcpServers": { ... } }` shape. VS Code project config can use `{ "servers": { ... } }`; Fusion normalizes it to the same import parser before rendering candidates.

Sensitive discovery follows the same no-plaintext rule as manual import. If a third-party file contains inline environment values, header values, or token-like values, the API response includes only secret descriptor metadata (`field`, `key`, `suggestedKey`, `scope`) and the candidate definition uses Fusion `McpSecretRef` placeholders. The dashboard **Add** flow opens the server editor so operators choose existing Fusion secrets or create new Fusion-managed secrets; the settings blob stores only `{ secretRef, scope }` references.

The dashboard uses this route:

```http
GET /api/mcp/discovered?scope=global|project
```

Response shape:

```json
{
  "sources": [{ "id": "vscode-project", "tool": "VS Code", "label": "VS Code project", "scope": "project", "path": "/repo/.vscode/mcp.json" }],
  "servers": [
    {
      "source": { "id": "vscode-project", "tool": "VS Code", "label": "VS Code project", "scope": "project", "path": "/repo/.vscode/mcp.json" },
      "definition": { "name": "docs", "transport": "stdio", "command": "node", "env": { "API_KEY": { "secretRef": "mcp.docs.env.API_KEY", "scope": "project" } } },
      "alreadyConfigured": false,
      "hasPlaintextSecrets": true,
      "secretDescriptors": [{ "field": "env", "key": "API_KEY", "suggestedKey": "mcp.docs.env.API_KEY", "scope": "project" }]
    }
  ],
  "errors": []
}
```

Expected outcome: API clients can display candidates, source labels, configured badges, and secret-binding prompts without receiving plaintext secret values.

## Managing servers from the CLI

1. List configured servers:

   ```bash
   fn mcp list [--project <name>] [--json]
   ```

   Expected outcome: Fusion prints global, project, and effective servers with secret summaries such as `project secret`, never decrypted values.

2. Add a stdio server:

   ```bash
   fn mcp add local-tools --scope project --transport stdio --command node --arg server.js --env API_KEY=my-existing-secret --secret-scope project
   ```

   Expected outcome: Fusion resolves `my-existing-secret` by id or key, stores it as `{ secretRef, scope }`, and prints `✓ Added MCP server "local-tools" to project scope`.

3. Add an SSE or streamable HTTP server:

   ```bash
   fn mcp add docs --scope global --transport sse --url https://example.test/sse --header Authorization=docs-token --secret-scope global
   fn mcp add http-docs --scope project --transport http --url https://example.test/mcp --secret-ref docs-token --secret-scope project
   ```

   Expected outcome: `sse` stores an SSE server, `http` is normalized to `streamable-http`, and `--secret-ref` supplies a token-like default secret field when no explicit `--env` or `--header` is present.

4. Create secrets while adding or editing:

   ```bash
   fn mcp add private-docs --scope project --transport streamable-http --url https://example.test/mcp --create-secret-header Authorization=Bearer-token-value
   ```

   Expected outcome: the CLI creates a Fusion secret with a suggested MCP key and persists only the new secret reference in settings.

5. Edit a scoped server:

   ```bash
   fn mcp edit local-tools --scope project --command node --args '["server.js","--verbose"]'
   ```

   Expected outcome: only the selected global or project declaration changes; effective project-over-global behavior is recomputed later by name.

6. Enable or disable a server:

   ```bash
   fn mcp enable local-tools --scope project
   fn mcp disable local-tools --scope project
   ```

   Expected outcome: Fusion flips the selected declaration's `enabled` flag. At project scope, disabling a same-named inherited server masks the global declaration without deleting it.

7. Remove a scoped declaration:

   ```bash
   fn mcp remove local-tools --scope project
   ```

   Expected outcome: the selected declaration is deleted. If you remove a project override, a same-named global server may become effective again.

8. Validate stored definitions:

   ```bash
   fn mcp validate [--scope global|project|effective] [--json]
   ```

   Expected outcome: Fusion reports whether stored definitions satisfy the MCP settings schema. Use the dashboard **Test** control or `POST /api/mcp/validate` for reachability.

## Importing Claude Desktop configuration

1. Prepare a Claude Desktop-style JSON file or paste payload:

   ```json
   {
     "mcpServers": {
       "docs": {
         "command": "node",
         "args": ["server.js"],
         "env": { "API_KEY": "plaintext-from-claude-config" }
       }
     }
   }
   ```

   Expected outcome: Fusion recognizes the `mcpServers` object and maps each entry to a named MCP server.

2. Import from the dashboard by opening **Settings → Global → MCP Servers** or **Settings → Project → MCP Servers**, pasting the JSON into **Import**, or choosing **Upload JSON**, then clicking **Import**. Expected outcome: plaintext env/header values are converted into Fusion secrets with `prompt` access policy and settings receive only secret references.

3. Import from the CLI:

   ```bash
   fn mcp import ./claude_desktop_config.json --scope project --yes
   ```

   Expected outcome: the CLI prints an import summary, creates Fusion secrets for plaintext env/header values, replaces them with secret references, and imports the definitions into the selected scope.

4. Review the imported rows with `fn mcp list` or the dashboard card before saving/applying broader settings changes. Expected outcome: duplicate names are visible, secret fields show as references, and effective project-over-global behavior is clear.

## Exporting Fusion MCP configuration

1. Export from the dashboard by opening the MCP settings card and clicking **Copy Fusion MCP JSON**. Expected outcome: the JSON is copied when clipboard access is available, and the export text appears for manual copy.
2. Click **Download JSON** after generating the dashboard export. Expected outcome: the browser downloads `fusion-mcp-servers.json`.
3. Export from the CLI:

   ```bash
   fn mcp export --scope effective --output fusion-mcp-servers.json
   fn mcp export --scope global --json
   ```

   Expected outcome: `--output` writes the JSON to a file; without `--output`, Fusion prints JSON to stdout. `global`, `project`, and `effective` choose stored global declarations, stored project declarations, or resolved project-over-global output.
4. Inspect the exported secret fields. Expected outcome: env/header values remain `{ secretRef, scope }` references and are not decrypted into plaintext.

## How MCP servers reach AI lanes

When an AI lane or readonly dashboard helper starts a session, Fusion resolves the effective `mcpServers` settings, materializes secret references through the scoped secrets store, and passes the resulting in-memory server declarations to runtimes that support MCP. The forwarding path covers chat/planning, executor, reviewer, validator, merger, workflow model nodes, summarization, evaluator, research, cron/automation, mission, reflection, subtask breakdown, text refinement/goal drafting, agent onboarding generation, PR metadata generation, and insight extraction paths.

Runtime support is guarded. Claude/pi/ACP-compatible runtimes receive MCP servers; mock or unsupported runtimes skip forwarding and emit only structured count/provider/runtime metadata. Skipped forwarding is not a settings error: it means the selected runtime does not accept MCP server declarations.

The default pi runtime connects resolved MCP servers inside the engine because pi does not consume raw `mcpServers` declarations itself. For each reachable server, Fusion performs the MCP handshake, lists tools, and registers each tool as a pi custom tool named `mcp__<server>__<tool>` with sanitized, deterministic suffixes for collisions. Unreachable or disabled servers fail soft with content-free logs, and all MCP clients/transports are closed when the agent session is disposed so stdio subprocesses are reaped.

Read-only sessions do not receive MCP tools automatically. Interactive planning and mission interview lanes (planning, streaming planning, mission interview, milestone interview, and slice interview) explicitly opt in because their job is to gather context and create plans, so configured MCP documentation/context tools are available there while still passing through the same custom-tool read-only filter, allowlists, permanent-agent gating, action-gate wrapping, worktree-boundary wrapping, schema preservation, redacted logging, and teardown path. Other read-only validator/helper lanes must make their own reviewed opt-in before external MCP tools appear.

Expected outcome: enabling a server makes it available to subsequent supported AI sessions and explicitly opted-in planning/mission read-only sessions, while unsupported sessions and read-only sessions without the opt-in continue without MCP tools and without logging secret-bearing server definitions.

See [Settings Reference](./settings-reference.md) for the `mcpServers` settings contract and [Agents](./agents.md) for runtime/model lane behavior.

## Fusion as an MCP server (`fn mcp serve`)

<!--
FNXC:McpDocs 2026-07-10-21:00:
Every other section on this page documents Fusion as an MCP *client* (configuring/forwarding external MCP servers). This section documents the inversion: `fn mcp serve` makes Fusion itself an MCP *server*, over local stdio only. Keep the curated tool list and safety boundaries below in sync with packages/cli/src/mcp-server/tools.ts (MCP_TOOL_REGISTRY, DESTRUCTIVE_TOOL_TIER, buildMcpToolRegistry) — that module is the single source of truth.

FNXC:McpDocs 2026-07-10-22:10:
FUSI-002 adds the off-by-default `--allow-destructive` flag and the first destructive tool tier (`fn_task_delete`, `fn_agent_delete`, `fn_workflow_delete`). FUSI-005 extends that tier with four mission-hierarchy delete tools (`fn_mission_delete`, `fn_milestone_delete`, `fn_slice_delete`, `fn_feature_delete`) behind the SAME flag. Keep the "Destructive tools" section in sync with `DESTRUCTIVE_TOOL_TIER` in tools.ts, and keep the flag's off-by-default default in sync with `BuildMcpServerOptions.allowDestructive` in server.ts.

FNXC:McpDocs 2026-07-10-23:30:
FUSI-003 adds a second transport (`--transport http`) alongside the stdio default. Unlike stdio, HTTP is network-facing, so the "Trust model" section below is now split: the stdio subsection keeps the original no-auth operator-privileged rationale verbatim, and a new HTTP subsection documents the re-derived boundary (loopback-by-default binding, mandatory bearer-token auth, hard refusal to bind non-loopback without a token). Keep this in sync with packages/cli/src/mcp-server/http-transport.ts.

FNXC:McpDocs 2026-07-10-23:59:
FUSI-006 adds `fn_task_archive` to the base v1 tool set (fifteen → sixteen; twenty-two → twenty-three with `--allow-destructive`). It is base-tier, NOT destructive, because it is a reversible soft-move restorable via `fn_task_unarchive`. `fn_goal_archive` was evaluated and explicitly DEFERRED (no `fn_goal_list`/`fn_goal_show` base tools exist yet to discover goal IDs) — see the filed follow-up task.

FNXC:McpDocs 2026-07-11-08:30:
FUSI-017 adds the read half of the mission hierarchy to the base v1 tool set (sixteen → twenty-four; twenty-three → thirty-one with `--allow-destructive`): `fn_mission_list`, `fn_mission_show`, `fn_milestone_list`/`fn_milestone_show`, `fn_slice_list`/`fn_slice_show`, `fn_feature_list`/`fn_feature_show`. All eight are base-tier reads (no `--allow-destructive` gate) that dispatch to the same `MissionStore` reads the pi-extension `fn_mission_list`/`fn_mission_show` handlers use; the per-level milestone/slice/feature tools have no pi-extension precedent and are net-new here.

FNXC:McpDocs 2026-07-11-10:30:
FUSI-018 adds the mutation half of the mission hierarchy plus a full goal tool set to the base v1 tool set (twenty-four → forty; thirty-one → forty-seven with `--allow-destructive`): `fn_mission_create`, `fn_mission_update`, `fn_milestone_add`, `fn_milestone_update`, `fn_slice_add`, `fn_slice_activate`, `fn_feature_add`, `fn_feature_update`, `fn_feature_link_task`, `fn_goal_list`, `fn_goal_show`, `fn_goal_create`, `fn_goal_archive`, `fn_mission_link_goal`, `fn_mission_unlink_goal`, `fn_mission_list_goals`. All sixteen are base-tier (no `--allow-destructive` gate) reversible create/update/link mutations that dispatch to the same `MissionStore`/`GoalStore` operations the pi-extension handlers use. This also resolves the `fn_goal_archive` deferral recorded in the FUSI-006 entry above: `fn_goal_list`/`fn_goal_show` (this task) now exist to discover goal IDs first.

FNXC:McpDocs 2026-07-11-09:30:
FUSI-019 adds settings read/write on top of FUSI-018's set (base tool count forty → forty-one; forty-seven → forty-nine with `--allow-destructive`): `fn_settings_get` (base-tier, scope-selected read of `project`/`global`/`effective` settings, dispatching to `TaskStore.getSettings()`/`getSettingsByScope()`, always through `redactSecretsDeep`) and `fn_settings_update` (destructive-tier, gated behind the SAME `--allow-destructive` flag — a shallow scope-selected PATCH via `store.updateSettings()`/`store.updateGlobalSettings()`, never a full-object replace; stderr audit carries patched key NAMES only, never values). Keep the counts below in sync with `MCP_TOOL_REGISTRY.length` / `DESTRUCTIVE_TOOL_TIER.length`.

FNXC:McpDocs 2026-07-11-10:00:
FUSI-020 adds the project tool family on top of FUSI-019's set, the last gap from the FUSI mission-hierarchy/settings/project MCP audit (base tool count forty-one → forty-three; forty-nine → fifty-four with `--allow-destructive`): `fn_project_list`/`fn_project_show` (base-tier reads over `CentralCore.listProjects()`/`getProject()`) and `fn_project_create`/`fn_project_update`/`fn_project_remove` (destructive-tier, gated behind the SAME `--allow-destructive` flag). CROSS-PROJECT BLAST RADIUS: unlike every other tool in this registry, these five dispatch to `CentralCore` — Fusion's GLOBAL cross-project registry (`~/.fusion/fusion-central.db`), NOT the single project `fn mcp serve` was launched for. An MCP session started for one project can list/inspect every registered project, and (destructive-tier) register, repath, rename, or unregister ANY project's registry entry — this is precisely why create/update/remove sit behind `--allow-destructive` even though `fn_project_remove` alone (a registry-entry-only unregister, never touching on-disk `.fusion/`) is reversible. `fn_project_create` covers both "register an existing `.fusion/` project" and "scaffold + register a brand-new one" via the shared, log-silent `scaffoldFusionProject` core extracted from `fn init`. Keep the counts below in sync with `MCP_TOOL_REGISTRY.length` / `DESTRUCTIVE_TOOL_TIER.length`.

FNXC:McpDocs 2026-07-11-11:00:
FUSI-021 is the consolidating quality gate after FUSI-017…020: it adds NO new tool, but (1) enforces the six registry invariants above — single combine point, destructive gating, `DESTRUCTIVE:` marker, stderr-only ids/counts/outcomes-only audit, `redactSecretsDeep` on every response, and no release/publish/version-tag/changeset tooling — structurally over the WHOLE registry via `packages/cli/src/mcp-server/__tests__/registry-invariants.test.ts`, so a future tool addition that violates one fails a test with no per-task edit here required, and (2) reconciled every stale tool-count reference across this page (the `Destructive tools` section previously undercounted the tier at "seven" instead of the real eleven) plus confirmed the FUSI-013 boot-smoke and `http-transport.test.ts` stay source-derived from `MCP_TOOL_REGISTRY`/`DESTRUCTIVE_TOOL_TIER` rather than hand-copied. After merging with FUSI-018's mission/goal mutation base tools, the current sizes at HEAD are: 43 base, 11 destructive, 54 combined.
-->

Every other command on this page configures Fusion as an MCP **client**. `fn mcp serve` is the inverse: it starts Fusion as an MCP **server**, so an operator's own MCP client (Claude Desktop, Claude Code, or any other MCP-compatible client) can connect to Fusion and drive the board directly — creating and inspecting tasks, delegating work to agents, and managing workflows — without going through the dashboard UI. Two transports are available: **stdio** (default, local subprocess) and **streamable HTTP** (network-facing, added by FUSI-003 for remote MCP clients).

### Running it

```bash
fn mcp serve [--project <name>] [--allow-destructive]
             [--transport stdio|http] [--port <n>] [--host <addr>] [--token <t>]
```

- Resolves the target project the same way every other `fn` command does: `--project <name>` (registered project name or ID), or CWD auto-detection when omitted.
- `--transport` defaults to `stdio` — every existing invocation is unchanged. Pass `--transport http` to serve over `StreamableHTTPServerTransport` instead (see "HTTP transport" below).
- Runs until the connected MCP client disconnects (stdio), or the listener is closed (HTTP), or until it receives `SIGINT`/`SIGTERM`. On every exit path — clean shutdown, signal, or a startup error — it closes the MCP server, the HTTP listener/transport (HTTP mode only), and the underlying `TaskStore`/SQLite handles before exiting (the same close-on-every-exit-path discipline the `fn mcp add/list/...` commands already follow).
- Never routes through the HTTP dashboard: every tool call, on either transport, dispatches directly to the same `@fusion/core` / `@fusion/engine` domain operations the pi-extension `fn_*` tools use.
- `--allow-destructive` is **off by default**. Omit it (or pass any other/malformed value) and the server exposes exactly the v1 tool set below, with zero `*_delete` tools — identical to running `fn mcp serve` before this flag existed. Pass `--allow-destructive` to opt into the destructive tool tier (see below). This is a boolean presence flag, not `--allow-destructive=true/false`. The same tool set (base or +destructive) is served on **both** transports — the transport only changes how bytes reach the server.

### The v1 tool allow-list

`fn mcp serve` exposes a curated, fixed set of tools — read operations plus safe mutations only. Nothing outside this list is reachable:

**Tasks**
- `fn_task_create` — create a task (enters the planning column; optional `workflow_id`)
- `fn_task_list` — list tasks grouped by column
- `fn_task_show` — show full task detail (steps, log, prompt)
- `fn_task_search` — full-text search across tasks
- `fn_task_archive` — archive a task from any live column to `archived`. This is a **reversible** soft-move (restorable via the dashboard's unarchive action / `store.unarchiveTask`) — not a deletion — so it is a base tool and does NOT require `--allow-destructive`. Pass `removeLineageReferences: true` to archive a task still referenced as a lineage parent. Dispatches to the same `TaskStore.archiveTask(id, { removeLineageReferences })` operation the pi-extension `fn_task_archive` tool uses.
- `fn_delegate_task` — create a task pre-assigned to a specific agent

**Agents**
- `fn_list_agents` — list agents, with role/state filters
- `fn_agent_show` — show a single agent's detail (org hierarchy, current assignment)
- `fn_agent_create` — create a new non-ephemeral agent
- `fn_agent_start` — resume a paused agent
- `fn_agent_stop` — pause a running agent

**Workflows**
- `fn_workflow_list` — list workflow definitions
- `fn_workflow_get` — fetch a workflow definition's IR
- `fn_workflow_create` — create a custom workflow definition
- `fn_workflow_update` — update a custom workflow definition
- `fn_workflow_select` — assign a workflow to a task (`task_id` is required — there is no ambient task context on this server)

**Missions**
- `fn_mission_list` — list all missions with their current status (plus in-flight mission interview drafts by default; pass `includeDrafts: false` to omit them). Dispatches to `store.getMissionStore().listMissions()`, the same operation the pi-extension `fn_mission_list` tool uses.
- `fn_mission_show` — show a single mission's full hierarchy (milestones → slices → features, plus linked goals). Dispatches to `getMissionWithHierarchy(id)`, the same operation the pi-extension `fn_mission_show` tool uses; a missing id returns an error result.
- `fn_milestone_list` / `fn_slice_list` / `fn_feature_list` — list the milestones under a mission, the slices under a milestone, or the features under a slice. Dispatch to `MissionStore.listMilestones(missionId)` / `.listSlices(milestoneId)` / `.listFeatures(sliceId)` respectively. An unknown parent id returns an empty (not an error) result.
- `fn_milestone_show` / `fn_slice_show` / `fn_feature_show` — show a single milestone, slice, or feature by ID (status, acceptance criteria/verification, parent/task links). Dispatch to `MissionStore.getMilestone(id)` / `.getSlice(id)` / `.getFeature(id)` respectively; a missing id returns an error result.

All eight mission tools are base-tier reads — they do NOT require `--allow-destructive`. The per-level `fn_milestone_*`/`fn_slice_*`/`fn_feature_*` tools have no pi-extension precedent; they exist so every hierarchy level is independently discoverable from an external MCP client without always walking the full mission tree via `fn_mission_show`. These read tools were added to unblock the create/update, settings, and project follow-up tools that need mission-hierarchy IDs to operate on.

**Missions & Goals (mutations)**
- `fn_mission_create` — create a new mission (`title` required; optional `description`, `autoAdvance`, `baseBranch`). Dispatches to `MissionStore.createMission(...)`, then `updateMission(...)` when `autoAdvance` is provided — the same operations the pi-extension `fn_mission_create` tool uses.
- `fn_mission_update` — partial-patch a mission's `title`/`description`. Rejects when no fields are provided or the mission id is unknown. Dispatches to `MissionStore.updateMission(id, updates)`.
- `fn_milestone_add` — add a milestone to a mission (`missionId`, `title` required). Dispatches to `MissionStore.addMilestone(missionId, ...)`; a missing parent mission returns an error.
- `fn_milestone_update` — partial-patch a milestone's `title`/`description`/`acceptanceCriteria`. Dispatches to `MissionStore.updateMilestone(id, updates)`.
- `fn_slice_add` — add a slice to a milestone (`milestoneId`, `title` required). Dispatches to `MissionStore.addSlice(milestoneId, ...)`; a missing parent milestone returns an error.
- `fn_slice_activate` — activate a `pending` slice so its features can be linked to tasks. Rejects a slice that is not `pending`. Dispatches to `await MissionStore.activateSlice(id)`.
- `fn_feature_add` — add a feature to a slice (`sliceId`, `title` required; optional `description`, `acceptanceCriteria`). Dispatches to `MissionStore.addFeature(sliceId, ...)`; a missing parent slice returns an error.
- `fn_feature_update` — partial-patch a feature's `title`/`description`/`acceptanceCriteria`. Dispatches to `MissionStore.updateFeature(id, updates)`.
- `fn_feature_link_task` — link a feature to a Fusion task (`featureId`, `taskId` required). Verifies the task exists on the active board, then dispatches to `MissionStore.linkFeatureToTask(featureId, taskId)` AND `store.updateTask(taskId, { sliceId })` — mirroring the pi-extension `fn_feature_link_task` tool exactly, including its "only active tasks can be linked" validation error.
- `fn_goal_list` — list goals filtered by `status` (`active` default, or `archived`/`all`), with the active-goal soft-warning/hard-cap counts. Dispatches to `store.getGoalStore().listGoals(...)`.
- `fn_goal_show` — show a single goal's full detail by ID. Dispatches to `GoalStore.getGoal(id)`; a missing id returns an error.
- `fn_goal_create` — create a new goal (`title` required; optional `description`). Dispatches to `GoalStore.createGoal(...)`; surfaces the `ACTIVE_GOAL_LIMIT_EXCEEDED` case as a structured (non-throwing) error result exactly as the pi-extension `fn_goal_create` tool does.
- `fn_goal_archive` — archive a goal by ID (idempotent — archiving an already-archived goal succeeds without error). Dispatches to `GoalStore.archiveGoal(id)`. This tool was **deferred** in FUSI-006 pending `fn_goal_list`/`fn_goal_show` existing to discover goal IDs first — both now exist above, so the deferral is resolved.
- `fn_mission_link_goal` / `fn_mission_unlink_goal` — link or unlink a goal to/from a mission (`missionId`, `goalId` required); linking an archived goal is rejected. Both return the mission's remaining linked-goal set for verification. Dispatch to `MissionStore.linkGoal(...)` / `.unlinkGoal(...)`.
- `fn_mission_list_goals` — list the goals currently linked to a mission (`missionId` required). Dispatches to `MissionStore.listGoalIdsForMission(missionId)` resolved through `GoalStore.getGoal(...)`.

All sixteen Missions & Goals mutation tools above are base-tier — they do NOT require `--allow-destructive`. Every one dispatches to the same `MissionStore`/`GoalStore` operation the corresponding pi-extension `fn_*` tool in `packages/cli/src/extension.ts` already calls; no new domain logic was introduced. The pi-extension's `fn_goal_list`/`fn_goal_show` handlers additionally emit a pi-run-scoped retrieval audit (`emitGoalRetrievalAudit`, keyed by agentId/runId/taskId) that is intentionally NOT replicated here — `fn mcp serve` has no pi run context to attach that audit to, matching how the FUSI-017 mission/milestone/slice/feature read tools already omit pi-side audit.

**Settings**
- `fn_settings_get` — read Fusion settings for a selected scope (`project`, `global`, or `effective`, the fully merged default). Base-tier read — does NOT require `--allow-destructive`. Dispatches to `store.getSettings()` (`effective`) or `store.getSettingsByScope()` (`project`/`global`), the same reads every other Fusion settings surface uses. Every returned settings object is passed through `redactSecretsDeep` before being returned — no secret-shaped value (tokens, API keys, MCP secret refs) ever leaves the server.

**Projects**
- `fn_project_list` — list every project registered in Fusion's central cross-project registry (not just the current project). Base-tier read — does NOT require `--allow-destructive`. Dispatches to `CentralCore.listProjects()`, the same read `fn project list` uses.
- `fn_project_show` — show full central-registry detail for a single project by id (or exact name). Base-tier read. Dispatches to `CentralCore.getProject(id)` (falling back to a name match over `listProjects()`), the same reads `fn project show` uses; an unknown id/name returns an error result.

> **Cross-project blast radius.** `fn_project_list`/`fn_project_show` (and the destructive `fn_project_create`/`fn_project_update`/`fn_project_remove` below) are the only tools in this registry that dispatch to `CentralCore` — Fusion's GLOBAL cross-project registry at `~/.fusion/fusion-central.db`, not the single project `fn mcp serve` was launched for. An MCP session started for Project A can read the registry entry for Project B, C, ... any registered project on the machine, and (destructive-tier) register, repath, rename, or unregister ANY of them. This is the reason `fn_project_create`/`fn_project_update`/`fn_project_remove` require `--allow-destructive` even though `fn_project_remove` alone is a reversible, registry-entry-only unregister.

The base-tier `fn_settings_get` plus `fn_project_list`/`fn_project_show` bring the base v1 tool count to forty-three; the destructive-tier `fn_settings_update` and `fn_project_create`/`fn_project_update`/`fn_project_remove` (all documented below) bring the `--allow-destructive` total to fifty-four.

### Destructive tools (`--allow-destructive`, off by default)

Starting `fn mcp serve --allow-destructive` adds exactly eleven additional tools on top of the v1 set above. **These are irreversible board mutations** — there is no undo from inside the MCP session (the exceptions being `fn_settings_update`, whose prior value is not captured for undo either but a subsequent `fn_settings_update` call can restore it, and `fn_project_remove`, which only unregisters a registry entry and is re-addable via `fn_project_create`):

- `fn_task_delete` — soft-deletes a task from active board views (the task row and artifacts are preserved; use `allowResurrection`/`removeLineageReferences` exactly as the pi-extension `fn_task_delete` tool does). Dispatches to the same `TaskStore.deleteTask(...)` operation.
- `fn_agent_delete` — deletes a non-ephemeral agent. Subject to the **same** `resolveAgentProvisioningPolicy` gate (`allow` / `require-approval` / `deny`) the pi-extension `fn_agent_delete` handler uses — a `deny` or `require-approval` policy decision is honored exactly as it is elsewhere; the agent is never deleted on those branches. Dispatches to `AgentStore.deleteAgent(...)`.
- `fn_workflow_delete` — deletes a custom workflow definition. Built-in workflows (`builtin:*`) remain protected — the store's rejection is surfaced, never bypassed. Any tasks pinned to the deleted workflow are re-homed to the default workflow's entry column.
- `fn_mission_delete` — deletes a mission, cascading unconditionally to **every** descendant milestone/slice/feature and unlinking (not deleting) any task linked to a descendant feature. There is no `force` parameter — `MissionStore.deleteMission(id)` has no guard to override. Dispatches to `store.getMissionStore().deleteMission(id)`, the same operation the pi-extension `fn_mission_delete` tool uses.
- `fn_milestone_delete` / `fn_slice_delete` / `fn_feature_delete` — delete a milestone (cascading to its slices/features), a slice (cascading to its features), or a single feature. Each accepts an optional `force` boolean mirroring the pi-extension tool exactly: by default, deletion is **rejected** with a `pass force to delete anyway` error when a descendant feature is linked to a live (non-archived, non-deleted) task; pass `force: true` to override the guard and clear the feature→task link (the task itself is never deleted). Dispatch to `MissionStore.deleteMilestone(id, force)` / `.deleteSlice(id, force)` / `.deleteFeature(id, force)` respectively — the store's guard is never bypassed by the MCP wrapper.
- `fn_settings_update` — apply a shallow, scope-selected PATCH (`scope: "project"` or `scope: "global"`, required) to Fusion settings. Never reads-then-replaces the whole settings object: `scope: "project"` dispatches straight to `store.updateSettings(patch)` (which already filters out keys that don't belong to project scope and treats a `null` patch value as an explicit key-delete); `scope: "global"` dispatches to `store.updateGlobalSettings(patch)` (merges into the global store and emits `settings:updated`). The result reports which patch keys were applied vs. dropped, but never echoes patched **values** back to the client.
- `fn_project_create` — register a project in the GLOBAL central registry: if `path` already has a valid `.fusion/fusion.db`, it registers the existing project (mirrors `fn project add`'s register flow — reads its identity file, calls `ensureProjectForPath` + `updateProject(active)` + `writeProjectIdentity`); otherwise it scaffolds a brand-new project folder via the same logic as `fn init` (shared `scaffoldFusionProject` core — creates `.fusion/`, `fusion.db`, optional `git init`, `.gitignore` entries) and then registers it. Accepts `path` (required), `name`, `isolation` (`in-process`/`child-process`), and `git` (boolean, scaffold-new path only).
- `fn_project_update` — apply a shallow patch (`name`/`path`/`status`/`isolationMode`) to a project's central-registry row via `CentralCore.updateProject(id, patch)`. An unknown id returns an error result.
- `fn_project_remove` — unregister a project's **central-registry entry only**, via `CentralCore.unregisterProject(id)`. This NEVER deletes `.fusion/` or any on-disk project file — the project directory and its `fusion.db` are left untouched, and the project remains re-addable at any time via `fn_project_create` or `fn project add`. Idempotent: removing an already-unregistered id returns `outcome: "noop"` rather than an error.

Each destructive tool's `description` begins with the literal marker `DESTRUCTIVE:` so it is unmistakable in any MCP client's tool listing. Every destructive invocation — success or failure — writes an ids/counts/outcomes-only audit line to **stderr** (never stdout): tool name, resource id, and outcome (`deleted` / `denied` / `pending_approval` / `updated` / `registered` / `created` / `unregistered` / `noop` / `error`). No prose and no secret values are ever included in that line. `fn_milestone_delete`/`fn_slice_delete`/`fn_feature_delete` append a `forced=true` marker to the outcome when the call passed `force: true`, so a stderr audit trail can be grepped for guard-overriding deletes specifically. `fn_mission_delete`'s audit line is further enriched with a pre-delete cascade summary — mission id/title plus the milestone/slice/feature counts and the number of task links cleared — captured before the cascading delete runs (the rows no longer exist to count afterward). `fn_settings_update`'s stderr audit line carries the patched key **NAMES only, never values** (settings patches may carry secret-bearing fields such as MCP secret refs). `fn_project_create`/`fn_project_update`/`fn_project_remove` carry the project id as the resource id; `fn_project_remove` audits `outcome: "noop"` (not an error) when the id was already unregistered, matching `unregisterProject`'s idempotent semantics.

`fn_mission_delete`'s mission-wide cascade reuses the **same** `--allow-destructive` flag as the rest of the tier rather than a second/stronger gate: the trust model (a local stdio subprocess under the operator's own OS privileges — see "Trust model" below) is identical for every tool in this tier, so a second CLI flag would add friction without defending against a different adversary. None of the four mission-hierarchy tools has a `resolveAgentProvisioningPolicy`-equivalent approval hook (unlike `fn_agent_delete`) — no bespoke approval/confirmation mechanism is invented for them; `--allow-destructive` plus the store's own live-task-link guard (for milestone/slice/feature deletion) is the complete gate. See FUSI-005's recorded task document (`key="design"`) for the full rationale.

### HTTP transport (`--transport http`, network-facing)

```bash
fn mcp serve --transport http --port <n> [--host <addr>] [--token <t>]
```

`--transport http` serves the SAME curated tool set (base or `--allow-destructive`) over `@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport` instead of stdio, so a remote/networked MCP client can connect instead of a same-machine subprocess. Because HTTP is a network-facing surface — not a same-machine trust boundary like stdio — it does **not** inherit stdio's no-auth trust model; the boundary is re-derived from scratch:

- **`--port <n>` is required.** Must be an integer 0–65535 (`0` requests an OS-assigned ephemeral port — used by this project's own tests, never port 4040).
- **Binds loopback (`127.0.0.1`) by default.** Pass `--host <addr>` to bind a different interface (e.g. `0.0.0.0` for LAN/remote access).
- **Bearer token authentication is required on every request.** Provide it via `--token <t>` or the `FN_MCP_TOKEN` environment variable. The server accepts the token either as an `Authorization: Bearer <token>` header (preferred) or a `?token=<token>` query-string fallback, mirroring the pattern in `packages/dashboard/src/auth-middleware.ts`. A missing or incorrect token gets `401` with no body leakage. Token comparison is constant-time (`crypto.timingSafeEqual`) to resist timing attacks.
- **Refuses to start on a non-loopback bind without a token.** If `--host` resolves to anything other than loopback and no token is configured (`--token`/`FN_MCP_TOKEN`), `fn mcp serve` exits with an error before opening the listener — a networked operator server must never run unauthenticated.
- **Loopback with no token is permitted but discouraged.** It starts, but emits a stderr warning recommending a token, since other local users/processes on a shared host can still reach a loopback-bound port.
- **`--port`/`--host`/`--token` are HTTP-only.** Supplying any of them with `--transport stdio` (or omitting `--transport`) is a validation error.
- MCP protocol bytes flow over the HTTP response body; stdout is never used by the HTTP transport. All diagnostics (bind address, auth-required notice, warnings) go to stderr, same as stdio mode.

### Safety boundaries

These are enforced by the tool registry itself, not just by caller discipline:

- **No release/publish/version-tag tooling.** Releasing is an operator-only action performed outside the task loop (see [Contributing](./contributing.md)); `fn mcp serve` never exposes `pnpm release`, `changeset publish`, `pnpm publish`, or git tagging.
- **`*_delete` tools are opt-in only.** The v1 base set (no `--allow-destructive`) ships zero `*_delete` tools, exactly as it did before this flag existed. `--allow-destructive` adds exactly the eleven tools documented above (seven `*_delete` tools, `fn_settings_update`, and `fn_project_create`/`fn_project_update`/`fn_project_remove`) — no more, no fewer — and is off by default.
- **No raw secret values.** Every tool result is passed through a redaction pass before being returned; secret-shaped fields (tokens, API keys, passwords, authorization headers) are never surfaced in a tool response. Secret management (`fn mcp add/edit --env/--header`, the Secrets view) is intentionally outside this server's allow-list entirely.

### Trust model

#### stdio (default)

`fn mcp serve` (no `--transport`, or `--transport stdio`) runs as a local stdio subprocess launched directly by the operator's own MCP client, under the operator's own OS user privileges. Every tool call is treated as an already-authenticated operator action — the same privileged-caller shape (`{ id: "user", role: "user", isPrivileged: true }`) the pi extension's `fn_agent_create` already uses. There is no additional network-facing authentication boundary, and none is needed: this is a local process talking to a local client over stdin/stdout, the same trust boundary as any other CLI command you run yourself.

`--allow-destructive` is not an additional authentication boundary either — it is an explicit operator confirmation that this particular `fn mcp serve` invocation should register delete-capable tools. Since every call is already treated as a privileged operator action, `fn_agent_delete`'s provisioning-policy check will typically resolve to `allow`; the `deny`/`require-approval` branches remain reachable (and are honored) whenever project settings configure a non-default `agentProvisioning` policy.

#### HTTP (`--transport http`) — does NOT inherit the stdio trust model

HTTP is a network-facing surface, not a same-machine pipe the operator's own shell launched — stdio's "no additional auth needed" reasoning does not transfer. `--transport http` re-derives the trust boundary instead of assuming it: loopback-by-default binding, mandatory bearer-token auth on every request, and a hard refusal to bind a non-loopback interface without a configured token (see "HTTP transport" above for the full policy). Treat an HTTP-mode `fn mcp serve` process exactly like any other network service that can create/mutate tasks, agents, and workflows: keep the token secret, prefer loopback binding plus an SSH tunnel or reverse proxy for remote access over exposing `--host 0.0.0.0` directly, and rotate the token if it may have leaked.

### Claude Desktop / Claude Code configuration

Add an entry to your MCP client's server configuration pointing at the `fn` binary with the `mcp serve` subcommand:

```json
{
  "mcpServers": {
    "fusion": {
      "command": "fn",
      "args": ["mcp", "serve", "--project", "my-project"]
    }
  }
}
```

Add `"--allow-destructive"` to `args` to also opt into the destructive tool tier:

```json
{
  "mcpServers": {
    "fusion": {
      "command": "fn",
      "args": ["mcp", "serve", "--project", "my-project", "--allow-destructive"]
    }
  }
}
```

Omit `--project` (and its argument) to have Fusion auto-detect the project from the working directory the client launches the process in. Expected outcome (no `--allow-destructive`): the client lists the forty-three curated Fusion tools above and can call them directly to manage the board. Expected outcome (with `--allow-destructive`): the client lists those forty-three tools **plus** `fn_task_delete`, `fn_agent_delete`, `fn_workflow_delete`, `fn_mission_delete`, `fn_milestone_delete`, `fn_slice_delete`, `fn_feature_delete`, `fn_settings_update`, `fn_project_create`, `fn_project_update`, and `fn_project_remove` — fifty-four tools total.

### Connecting a remote client over HTTP

First start the HTTP transport with a token (do this outside the MCP client — `fn mcp serve` is a long-running process):

```bash
FN_MCP_TOKEN="$(openssl rand -hex 32)" fn mcp serve --project my-project --transport http --port 8765
```

Then point an MCP client that supports streamable-HTTP servers at the endpoint, supplying the same token as a bearer header:

```json
{
  "mcpServers": {
    "fusion": {
      "url": "http://127.0.0.1:8765",
      "headers": {
        "Authorization": "Bearer <the FN_MCP_TOKEN value>"
      }
    }
  }
}
```

For genuinely remote (non-loopback) access, bind explicitly with `--host` and a token is then mandatory (the server refuses to start otherwise):

```bash
FN_MCP_TOKEN="$(openssl rand -hex 32)" fn mcp serve --project my-project --transport http --host 0.0.0.0 --port 8765
```

Prefer tunneling (SSH port-forward, VPN, reverse proxy with TLS) over exposing `--host 0.0.0.0` directly on an untrusted network — this transport does not terminate TLS itself.
