#!/usr/bin/env python3
"""One-shot resolver for upstream/main merge conflicts."""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text)


def resolved(path: str) -> bool:
    return "<<<<<<<" not in read(path)


def merge_json_locale(path: str) -> None:
    text = read(path)
    if "<<<<<<<" not in text:
        return
    ours_m = re.search(r"<<<<<<< HEAD\n(.*?)\n=======\n(.*?)\n>>>>>>> upstream/main", text, re.S)
    if not ours_m:
        return
    ours = json.loads(ours_m.group(1))
    theirs = json.loads(ours_m.group(2))

    def deep_merge(a: dict, b: dict) -> dict:
        out = dict(a)
        for k, v in b.items():
            if k in out and isinstance(out[k], dict) and isinstance(v, dict):
                out[k] = deep_merge(out[k], v)
            else:
                out[k] = v
        return out

    merged = deep_merge(ours, theirs)
    write(path, json.dumps(merged, ensure_ascii=False, indent=2) + "\n")


def replace(path: str, old: str, new: str) -> None:
    text = read(path)
    if old not in text:
        return
    write(path, text.replace(old, new))


def resolve_engine() -> None:
    # executor.ts
    p = "packages/engine/src/executor.ts"
    t = read(p)
    t = t.replace(
        """<<<<<<< HEAD
  /*
   * FNXC:McpConfig 2026-06-25-22:20:
   * Executor-owned lanes (main execution, retry, workflow model nodes, self-fix, and spawned child sessions) resolve the same trusted MCP server set from the task store immediately before session creation so secret material is never persisted in task state.
   *
   * FNXC:McpConfig 2026-07-12-01:00:
   * FUSI-077: return a spreadable options fragment (`mcpServers` + `mcpSettingsStore` + `mcpServerScopeByName`),
   * not just the resolved server array, so every call site below forwards the owning store + scope map into
   * `createFnAgent`/`createResolvedAgentSession` and a non-interactive OAuth refresh persists via the
   * settings-backed McpOAuthTokenStore (FUSI-076) instead of falling back to the warn-only in-memory default.
   */
  private async resolveMcpServers(agentId?: string | null) {
    const resolved = await resolveMcpServersForStore(this.store, { agentId: agentId ?? undefined });
    return { mcpServers: resolved.servers, mcpSettingsStore: this.store, mcpServerScopeByName: resolved.scopeByServerName };
=======
  private async parkApprovalSuspension(taskId: string, surface: string): Promise<boolean> {""",
        """  private async parkApprovalSuspension(taskId: string, surface: string): Promise<boolean> {""",
    )
    t = t.replace(
        """    return assertMcpResolutionSucceeded(resolved);
>>>>>>> upstream/main
  }""",
        """    return {
      mcpServers: assertMcpResolutionSucceeded(resolved),
      mcpSettingsStore: this.store,
      mcpServerScopeByName: resolved.scopeByServerName,
    };
  }""",
    )
    t = re.sub(
        r"<<<<<<< HEAD\n            \.\.\.\(await this\.resolveMcpServers\(identityAgent\?\.id\)\),\n            // Skill selection: use assigned agent skills if available, otherwise role fallback\n=======\n            mcpServers: await this\.resolveMcpServers\(identityAgent\?\.id\),\n            // FNXC:PluginSkills[^\n]*\n>>>>>>> upstream/main",
        "...(await this.resolveMcpServers(identityAgent?.id)),\n            // FNXC:PluginSkills 2026-07-12-00:00: Plugin skill session delivery requires forwarding both requested names and body directories so the pi loader can discover plugin-package SKILL.md files.",
        t,
    )
    t = re.sub(
        r"<<<<<<< HEAD\n                  \.\.\.\(await this\.resolveMcpServers\(identityAgent\?\.id\)\),\n                  // Skill selection: use assigned agent skills if available, otherwise role fallback\n=======\n                  mcpServers: await this\.resolveMcpServers\(identityAgent\?\.id\),\n                  // FNXC:PluginSkills[^\n]*\n>>>>>>> upstream/main",
        "...(await this.resolveMcpServers(identityAgent?.id)),\n                  // FNXC:PluginSkills 2026-07-12-00:00: Retry executor sessions must keep the same plugin skill body discovery paths as the primary attempt so requested plugin skill names resolve to real bodies.",
        t,
    )
    t = t.replace(
        """<<<<<<< HEAD
              fallbackThinkingLevel: resolveValidatorFallbackThinkingLevel(latestDetailForReview.thinkingLevel, settings),
              defaultThinkingLevel: resolveValidatorThinkingLevel(latestDetailForReview.thinkingLevel, settings),
=======
              /*
               * FNXC:Settings-ThinkingLevel 2026-07-13-00:27:
               * Pre-merge review sessions honor the per-task validator override before shared task thinking, preserving shared-task fallback for legacy tasks.
               */
              fallbackThinkingLevel: resolveValidatorFallbackThinkingLevel(latestDetailForReview.validatorThinkingLevel ?? latestDetailForReview.thinkingLevel, settings),
              defaultThinkingLevel: resolveValidatorThinkingLevel(latestDetailForReview.validatorThinkingLevel ?? latestDetailForReview.thinkingLevel, settings),
>>>>>>> upstream/main""",
        """              /*
               * FNXC:Settings-ThinkingLevel 2026-07-13-00:27:
               * Pre-merge review sessions honor the per-task validator override before shared task thinking, preserving shared-task fallback for legacy tasks.
               */
              fallbackThinkingLevel: resolveValidatorFallbackThinkingLevel(latestDetailForReview.validatorThinkingLevel ?? latestDetailForReview.thinkingLevel, settings),
              defaultThinkingLevel: resolveValidatorThinkingLevel(latestDetailForReview.validatorThinkingLevel ?? latestDetailForReview.thinkingLevel, settings),""",
    )
    t = re.sub(
        r"<<<<<<< HEAD\n      /\*\n       \* FNXC:SessionWiring.*?=======\n>>>>>>> upstream/main",
        lambda m: m.group(0).split("=======")[0].replace("<<<<<<< HEAD\n", ""),
        t,
        flags=re.S,
    )
    write(p, t)

    # merger.ts
    p = "packages/engine/src/merger.ts"
    pairs = [
        (
            """<<<<<<< HEAD
      ...(await resolveMergerMcpServers(store, assignedAgent?.id)),
      // Skill selection: use assigned agent skills if available, otherwise role fallback
=======
      mcpServers: await resolveMergerMcpServers(store, assignedAgent?.id),
      // FNXC:PluginSkills 2026-07-12-00:00: Merger verification-fix sessions forward plugin skill body dirs with requested names so plugin merge guidance is discoverable in live sessions.
>>>>>>> upstream/main""",
            """...(await resolveMergerMcpServers(store, assignedAgent?.id)),
      // FNXC:PluginSkills 2026-07-12-00:00: Merger verification-fix sessions forward plugin skill body dirs with requested names so plugin merge guidance is discoverable in live sessions.""",
        ),
        (
            """<<<<<<< HEAD
    ...(await resolveMergerMcpServers(store, assignedAgent?.id)),
=======
    mcpServers: await resolveMergerMcpServers(store, assignedAgent?.id),
    // FNXC:PluginSkills 2026-07-12-00:00: Autostash conflict sessions must preserve plugin skill body dirs from the shared skill context.
>>>>>>> upstream/main""",
            """...(await resolveMergerMcpServers(store, assignedAgent?.id)),
    // FNXC:PluginSkills 2026-07-12-00:00: Autostash conflict sessions must preserve plugin skill body dirs from the shared skill context.""",
        ),
        (
            """<<<<<<< HEAD
    ...(await resolveMergerMcpServers(store, assignedAgent?.id)),
=======
    mcpServers: await resolveMergerMcpServers(store, assignedAgent?.id),
    // FNXC:PluginSkills 2026-07-12-00:00: Autostash hard-fail recovery sessions keep plugin body discovery paths aligned with requested plugin skills.
>>>>>>> upstream/main""",
            """...(await resolveMergerMcpServers(store, assignedAgent?.id)),
    // FNXC:PluginSkills 2026-07-12-00:00: Autostash hard-fail recovery sessions keep plugin body discovery paths aligned with requested plugin skills.""",
        ),
        (
            """<<<<<<< HEAD
    ...(await resolveMergerMcpServers(store, assignedAgent?.id)),
    // Skill selection: use assigned agent skills if available, otherwise role fallback
=======
    mcpServers: await resolveMergerMcpServers(store, assignedAgent?.id),
    // FNXC:PluginSkills 2026-07-12-00:00: Merge-authoring sessions forward plugin skill body dirs so plugin-contributed merger skills load their bodies.
>>>>>>> upstream/main""",
            """...(await resolveMergerMcpServers(store, assignedAgent?.id)),
    // FNXC:PluginSkills 2026-07-12-00:00: Merge-authoring sessions forward plugin skill body dirs so plugin-contributed merger skills load their bodies.""",
        ),
    ]
    t = read(p)
    for old, new in pairs:
        t = t.replace(old, new)
    write(p, t)

    replace(
        "packages/engine/src/triage.ts",
    """<<<<<<< HEAD
          mcpServers: resolvedTriageMcp.servers,
          // FNXC:McpConfig 2026-07-12-01:00: FUSI-077 — forward the owning store + scope map so OAuth refreshes persist via the settings-backed token store instead of the warn-only default.
          mcpSettingsStore: this.store,
          mcpServerScopeByName: resolvedTriageMcp.scopeByServerName,
          // Skill selection: use assigned agent skills if available, otherwise role fallback
=======
          mcpServers: (await resolveMcpServersForStore(this.store)).servers,
          // FNXC:PluginSkills 2026-07-12-00:00: Triage sessions forward plugin skill body dirs with requested names so plugin-authored planning guidance is discoverable by the pi loader.
>>>>>>> upstream/main""",
    """          mcpServers: resolvedTriageMcp.servers,
          // FNXC:McpConfig 2026-07-12-01:00: FUSI-077 — forward the owning store + scope map so OAuth refreshes persist via the settings-backed token store instead of the warn-only default.
          mcpSettingsStore: this.store,
          mcpServerScopeByName: resolvedTriageMcp.scopeByServerName,
          // FNXC:PluginSkills 2026-07-12-00:00: Triage sessions forward plugin skill body dirs with requested names so plugin-authored planning guidance is discoverable by the pi loader.""",
    )


def resolve_grok_upstream() -> None:
    deleted = [
        "plugins/fusion-plugin-grok-runtime/src/__tests__/cli-stream.test.ts",
        "plugins/fusion-plugin-grok-runtime/src/__tests__/stream-parser.test.ts",
        "plugins/fusion-plugin-grok-runtime/src/cli-stream.ts",
        "plugins/fusion-plugin-grok-runtime/src/stream-parser.ts",
    ]
    for path in deleted:
        full = ROOT / path
        if full.exists():
            full.unlink()
        subprocess.run(["git", "rm", "-f", path], cwd=ROOT, check=False, capture_output=True)

    for path in [
        "plugins/fusion-plugin-grok-runtime/README.md",
        "plugins/fusion-plugin-grok-runtime/src/__tests__/runtime-adapter.test.ts",
        "plugins/fusion-plugin-grok-runtime/src/runtime-adapter.ts",
        "plugins/fusion-plugin-grok-runtime/src/types.ts",
    ]:
        subprocess.run(["git", "checkout", "--theirs", path], cwd=ROOT, check=False)


def resolve_routes() -> None:
    p = "packages/dashboard/src/routes.ts"
    t = read(p)
    t = t.replace(
        """<<<<<<< HEAD
import type { AnthropicProviderRegistration, TaskStore, ScheduleType, ActivityEventType, ModelPreset, RoutineTriggerType, McpServerDefinition, McpSecretRef, ResolvedMcpServerDefinition } from "@fusion/core";
import { isMcpSecretRef } from "@fusion/core";import {
=======
import type { AnthropicProviderRegistration, TaskStore, ScheduleType, ActivityEventType, ModelPreset, RoutineTriggerType, McpServerDefinition, ThinkingLevel } from "@fusion/core";
import {
>>>>>>> upstream/main""",
        """import type { AnthropicProviderRegistration, TaskStore, ScheduleType, ActivityEventType, ModelPreset, RoutineTriggerType, McpServerDefinition, McpSecretRef, ResolvedMcpServerDefinition, ThinkingLevel } from "@fusion/core";
import { isMcpSecretRef } from "@fusion/core";
import {""",
    )
    t = t.replace(
        """<<<<<<< HEAD
  const { mcpServers, scopeByServerName } = await resolveManualAiPromptMcpServersWithScope(taskStore);
=======
  const mcpServers = await resolveManualAiPromptMcpServers(taskStore);
  const defaultThinkingLevel = step.thinkingLevel?.trim() || undefined;
>>>>>>> upstream/main""",
        """  const { mcpServers, scopeByServerName } = await resolveManualAiPromptMcpServersWithScope(taskStore);
  const defaultThinkingLevel = step.thinkingLevel?.trim() || undefined;""",
    )
    write(p, t)


def resolve_docs_both() -> None:
    for path in [
        "AGENTS.md",
        "ROADMAP.md",
        "docs/architecture.md",
        "docs/dashboard-guide.md",
        "docs/grok-cli-contract.md",
        "docs/settings-reference.md",
    ]:
        text = read(path)
        if "<<<<<<<" not in text:
            continue
        # Keep both sides' unique paragraphs where possible
        text = re.sub(
            r"<<<<<<< HEAD\n(.*?)=======\n(.*?)>>>>>>> upstream/main",
            lambda m: m.group(1).rstrip() + "\n\n" + m.group(2).lstrip(),
            text,
            flags=re.S,
        )
        write(path, text)


def resolve_generic_both(path: str) -> None:
    text = read(path)
    if "<<<<<<<" not in text:
        return
    text = re.sub(
        r"<<<<<<< HEAD\n(.*?)=======\n(.*?)>>>>>>> upstream/main",
        lambda m: m.group(1).rstrip() + "\n" + m.group(2).lstrip(),
        text,
        flags=re.S,
    )
    write(path, text)


def main() -> None:
    resolve_engine()
    resolve_routes()
    resolve_grok_upstream()

    for loc in [
        "packages/i18n/locales/en/app.json",
        "packages/i18n/locales/es/app.json",
        "packages/i18n/locales/fr/app.json",
        "packages/i18n/locales/ko/app.json",
        "packages/i18n/locales/zh-CN/app.json",
        "packages/i18n/locales/zh-TW/app.json",
    ]:
        merge_json_locale(loc)

    resolve_docs_both()

    # Prefer upstream for mobile/UI polish where both touched; re-apply via generic both for core user features
    upstream_prefer = [
        "packages/dashboard/app/components/ChatView.tsx",
        "packages/dashboard/app/components/StandardChatSurface.tsx",
        "packages/dashboard/app/components/TaskCard.css",
        "packages/dashboard/app/components/TaskDetailModal.css",
        "packages/dashboard/app/components/TaskDetailModal.tsx",
        "packages/dashboard/app/components/TerminalModal.tsx",
        "packages/dashboard/app/components/SelectionCommentPopover.css",
        "packages/dashboard/app/components/ListView.tsx",
        "packages/dashboard/app/components/MemoryView.tsx",
        "packages/dashboard/app/components/SettingsModal.css",
        "packages/dashboard/app/components/__tests__/ChatView.chat-commands.test.tsx",
        "packages/dashboard/app/components/__tests__/settings-mobile.test.tsx",
        "packages/dashboard/app/components/__tests__/TaskDetailModal.worktree-terminal.test.tsx",
        "packages/dashboard/app/utils/priorityIndicator.tsx",
        "packages/dashboard/app/utils/__tests__/priorityIndicator.test.tsx",
        "packages/dashboard/src/chat.ts",
        "packages/dashboard/src/__tests__/chat-manager.test.ts",
        "packages/dashboard/src/skills-adapter.ts",
        "packages/dashboard/src/planning.ts",
        "packages/dashboard/app/components/settings/sections/ProjectModelsSection.tsx",
        "packages/engine/src/agent-session-helpers.ts",
        "packages/engine/src/agent-tools.ts",
        "packages/engine/src/cron-runner.ts",
        "packages/engine/src/merger-ref-update-advance.ts",
        "packages/engine/src/__tests__/agent-session-helpers.test.ts",
        "packages/engine/src/__tests__/grok-runtime-routing.test.ts",
        "packages/core/src/chat-types.ts",
        "packages/core/src/__tests__/chat-store.test.ts",
        "packages/core/src/__tests__/plugin-loader.test.ts",
        "packages/core/src/__tests__/db-migrate.test.ts",
        "packages/dashboard/src/__tests__/skills-adapter.test.ts",
        "packages/dashboard/app/components/__tests__/SelectionCommentPopover.test.tsx",
    ]
    for path in upstream_prefer:
        if "<<<<<<<" in read(path):
            subprocess.run(["git", "checkout", "--theirs", path], cwd=ROOT, check=False)

    # User-feature heavy: merge both sides
    for path in [
        "packages/core/src/chat-store.ts",
        "packages/core/src/db.ts",
        "packages/core/src/store.ts",
        "packages/dashboard/app/components/ArtifactsGallery.css",
        "packages/dashboard/app/components/DocumentsView.css",
        "packages/dashboard/app/components/DocumentsView.tsx",
        "packages/dashboard/app/components/QuickEntryBox.tsx",
        "packages/dashboard/app/components/TaskForm.tsx",
        "packages/dashboard/app/components/__tests__/DocumentsView.test.tsx",
        "packages/dashboard/app/components/__tests__/QuickEntryBox.test.tsx",
        "packages/dashboard/src/__tests__/usage.test.ts",
        "packages/dashboard/src/usage.ts",
    ]:
        resolve_generic_both(path)

    # lockfile: theirs then regenerate later
    subprocess.run(["git", "checkout", "--theirs", "pnpm-lock.yaml"], cwd=ROOT, check=False)

    remaining = subprocess.check_output(
        ["git", "diff", "--name-only", "--diff-filter=U"], cwd=ROOT, text=True
    ).strip().splitlines()
    still = [p for p in remaining if p and "<<<<<<<" in read(p)]
    print("Remaining conflict markers:", len(still))
    for p in still:
        print(" ", p)


if __name__ == "__main__":
    main()
