/**
 * Pure helpers for the `fn mcp serve` (stdio transport) boot-smoke stage.
 *
 * FNXC:BootSmoke 2026-07-10-00:00:
 * FUSI-001 shipped `fn mcp serve` with only *in-memory* test coverage
 * (`InMemoryTransport` / `StreamableHTTPClientTransport` against
 * `buildMcpServer(...)` directly) and that suite passed while the real
 * built binary had two runtime-only failures an operator hit immediately:
 *   1. `@modelcontextprotocol/sdk` was declared in `packages/cli/package.json`
 *      but never installed, so the built binary crashed at startup with
 *      `Cannot find package @modelcontextprotocol/sdk` before ever reaching
 *      the MCP handshake.
 *   2. A `[title-id-drift]` `console.log` from `@fusion/core`'s DB-open
 *      path landed on stdout, which IS the JSON-RPC wire in stdio mode, so
 *      strict clients (Claude Desktop) failed with
 *      `Unexpected token … is not valid JSON`.
 * Neither failure is visible to in-memory tests because they never spawn
 * the built `dist/bin.js` as a real subprocess and never read raw stdout
 * bytes — they hand a `Transport` object directly to the SDK's `Client`,
 * which is exactly the layer that would swallow or reformat a stray line.
 * This module is intentionally SDK-free and pure (no subprocess, no I/O)
 * so `scripts/__tests__/mcp-serve-smoke.test.mjs` can unit-test the exact
 * "0 stray stdout lines" assertion against captured-string fixtures, and
 * `scripts/boot-smoke.mjs` can reuse the identical logic against a real
 * spawned child without duplicating the validator.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Split raw stdout captured from an `fn mcp serve --transport stdio` child
 * into parsed JSON-RPC messages and "stray" lines that are not valid
 * JSON-RPC 2.0 objects.
 *
 * FNXC:BootSmoke 2026-07-10-00:00:
 * The SDK's `StdioServerTransport` wire format is newline-delimited JSON
 * (one message per `\n`-terminated line) — there is no `Content-Length`
 * framing on this transport, so splitting on `\n` and trimming empty/
 * trailing lines is the correct and complete parse. A line is only
 * accepted as a JSON-RPC message when it parses to an object AND carries
 * `"jsonrpc": "2.0"` — any other non-empty line (a human banner, a
 * `console.log`, a `[title-id-drift]` diagnostic) is a stray line and is
 * exactly what the class-2 FUSI-001 regression looked like on the wire.
 *
 * @param {string} stdout raw captured stdout bytes (already utf8-decoded)
 * @returns {{ messages: any[], strayLines: string[] }}
 */
export function parseJsonRpcStream(stdout) {
  const lines = String(stdout ?? "").split("\n");
  const messages = [];
  const strayLines = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim().length === 0) continue; // ignore blank/trailing lines
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      strayLines.push(line);
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || parsed.jsonrpc !== "2.0") {
      strayLines.push(line);
      continue;
    }
    messages.push(parsed);
  }
  return { messages, strayLines };
}

function truncate(line, max = 200) {
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * Throw a descriptive error naming the first stray (non-JSON-RPC) line
 * found in `stdout`. This is the contamination detector: a clean stdio
 * boot must produce ZERO stray lines. Any `console.log`/`console.info`/
 * `console.debug`/banner/migration-diagnostic on stdout in stdio mode is
 * a protocol violation for strict JSON-RPC clients (the FUSI-001
 * `[title-id-drift]` incident).
 *
 * @param {string} stdout
 */
export function assertOnlyJsonRpcLines(stdout) {
  const { strayLines } = parseJsonRpcStream(stdout);
  if (strayLines.length > 0) {
    throw new Error(
      `mcp serve (stdio) emitted ${strayLines.length} non-JSON-RPC stdout line(s); first: ${truncate(strayLines[0])}`,
    );
  }
}

/**
 * Find the JSON-RPC response with the given `id` among parsed `messages`
 * and, if it carries a `tools/list` result shape, return its tool names
 * sorted. Returns `null` when no matching response (or no `result.tools`)
 * is present — callers treat that as "response never arrived" (the
 * class-1 startup-crash symptom: the SDK never resolved so no response
 * was ever written to stdout).
 *
 * @param {any[]} messages parsed JSON-RPC messages (from parseJsonRpcStream)
 * @param {string|number} id the request id used for the `tools/list` call
 * @returns {string[] | null}
 */
export function extractToolListNames(messages, id) {
  const response = messages.find((m) => m.id === id && m.result && Array.isArray(m.result.tools));
  if (!response) return null;
  return response.result.tools.map((t) => t.name).sort();
}

/**
 * Compare an actual (sorted or unsorted) tool-name list against an
 * expected curated set and throw a descriptive error on any drift
 * (missing tool, unexpected extra tool). Both lists are compared as sets
 * via sorted-array equality so ordering never matters.
 *
 * @param {string[]} actualNames
 * @param {string[]} expectedNames
 */
export function assertCuratedToolSet(actualNames, expectedNames) {
  const actual = [...actualNames].sort();
  const expected = [...expectedNames].sort();
  const missing = expected.filter((n) => !actual.includes(n));
  const unexpected = actual.filter((n) => !expected.includes(n));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `tools/list drifted from the curated set — missing: [${missing.join(", ")}], unexpected: [${unexpected.join(", ")}]`,
    );
  }
}

/**
 * Seed a throwaway project directory with a real, minimal `.fusion/fusion.db`
 * so `fn mcp serve` (which requires an EXISTING project and never
 * auto-registers one, unlike `fn serve`) can detect it via CWD auto-detect
 * instead of exiting immediately with "No fusion project found".
 *
 * Imports `TaskStore` directly from the built `packages/core/dist/index.js`
 * (rather than the bare `@fusion/core` specifier, which is only resolvable
 * from inside a `@fusion/*` package's own node_modules, not from a
 * top-level `scripts/` script) — the same DB shape `resolveProject`'s
 * `detectProjectFromCwd` validates via `isValidSqliteDatabaseFile`.
 *
 * @param {string} projectDir absolute path to the throwaway project directory
 */
async function bootstrapIsolatedProject(projectDir) {
  mkdirSync(path.join(projectDir, ".fusion"), { recursive: true });
  const coreDistEntry = path.join(repoRoot, "packages/core/dist/index.js");
  const { TaskStore } = await import(pathToFileURL(coreDistEntry).href);
  const store = new TaskStore(projectDir);
  await store.init();
  await store.close();
}

/**
 * Spawn the built `fn mcp serve` binary (stdio transport) as a real
 * subprocess, drive it with a newline-delimited `initialize` request +
 * `notifications/initialized` + `tools/list` request, and assert:
 *   1. the process responds (proves `@modelcontextprotocol/sdk` resolved
 *      and no startup crash — the class-1 FUSI-001 regression),
 *   2. every non-empty stdout line is valid JSON-RPC (the class-2
 *      FUSI-001 `[title-id-drift]` regression),
 *   3. `tools/list` returns exactly `expectedToolNames`.
 *
 * FNXC:BootSmoke 2026-07-10-00:00:
 * Deliberately does NOT use the SDK's `Client`/`StdioClientTransport` — a
 * tolerant client could silently swallow or reorder interleaved non-JSON
 * bytes, which would hide exactly the contamination this gate exists to
 * catch. Raw stdout capture + the pure validator above is required for an
 * exact "0 stray lines" assertion.
 *
 * @param {object} options
 * @param {string} options.cliBin absolute path to `packages/cli/bin.mjs`
 * @param {string[]} options.expectedToolNames curated tool names to assert against
 * @param {number} [options.timeoutMs] bound on waiting for the tools/list response (default 30_000)
 * @param {number} [options.shutdownTimeoutMs] bound on graceful SIGTERM shutdown (default 10_000)
 * @param {(spawn: typeof import("node:child_process").spawn) => typeof import("node:child_process").spawn} [options._spawn] test seam
 * @returns {Promise<{ toolNames: string[], stdout: string, stderr: string }>}
 */
export async function runMcpServeStdioSmoke({
  cliBin,
  expectedToolNames,
  timeoutMs = 30_000,
  shutdownTimeoutMs = 10_000,
  removeTempDir,
}) {
  const isolatedHome = mkdtempSync(path.join(tmpdir(), "fusion-mcp-smoke-home-"));
  const isolatedProject = mkdtempSync(path.join(tmpdir(), "fusion-mcp-smoke-project-"));

  /*
   * FNXC:BootSmoke 2026-07-10-00:00:
   * `fn mcp serve` (unlike `fn serve`) requires an EXISTING fusion project
   * (`runMcpServe` -> `loadContext(_, requireProject=true)` ->
   * `resolveProject`) and never auto-registers one — that auto-register
   * behavior belongs only to `fn serve`'s `ensureCwdProjectRegistered`. So
   * the throwaway project dir needs a real `.fusion/fusion.db` seeded
   * BEFORE the child spawns, or `mcp serve` exits immediately with
   * "No fusion project found". Bootstrapping via a real `TaskStore.init()`
   * (imported directly from the built `packages/core/dist/index.js`, since
   * `@fusion/core` is not resolvable as a bare specifier from this
   * top-level `scripts/` script) is the same DB shape `resolveProject`'s
   * `detectProjectFromCwd` validates via `isValidSqliteDatabaseFile`, and
   * mirrors the pattern already used by http-transport.test.ts /
   * tools.test.ts to stand up a project dir without the CLI.
   */
  await bootstrapIsolatedProject(isolatedProject);

  const cleanupDirs = () => {
    if (typeof removeTempDir === "function") {
      removeTempDir(isolatedHome);
      removeTempDir(isolatedProject);
    }
  };

  const child = spawn(process.execPath, [cliBin, "mcp", "serve"], {
    cwd: isolatedProject,
    env: {
      ...process.env,
      HOME: isolatedHome,
      FUSION_SKIP_ONBOARDING: "1",
      PORT: undefined,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));

  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  const initializeRequest = {
    jsonrpc: "2.0",
    id: "fusi-013-initialize",
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "fusion-boot-smoke", version: "0.0.0" },
    },
  };
  const initializedNotification = { jsonrpc: "2.0", method: "notifications/initialized" };
  const toolsListId = "fusi-013-tools-list";
  const toolsListRequest = { jsonrpc: "2.0", id: toolsListId, method: "tools/list", params: {} };

  const writeLine = (message) => {
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // Child may have already exited (startup crash) — surfaced by exited()/timeout below.
    }
  };

  writeLine(initializeRequest);
  // Give the child a brief beat to answer initialize before pushing the
  // rest of the handshake — the SDK server itself is fine receiving them
  // back-to-back, but this mirrors a real client's request/response cadence
  // and avoids racing notifications/initialized ahead of the child process
  // even attaching its stdin listener.
  await new Promise((r) => setTimeout(r, 50));
  writeLine(initializedNotification);
  writeLine(toolsListRequest);

  const waitForToolsListResponse = async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { messages } = parseJsonRpcStream(stdout);
      const names = extractToolListNames(messages, toolsListId);
      if (names !== null) return names;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  };

  let toolNames;
  try {
    const raced = await Promise.race([
      waitForToolsListResponse().then((names) => ({ kind: "response", names })),
      exited.then((info) => ({ kind: "exited", info })),
    ]);
    if (raced.kind === "exited") {
      throw new Error(
        `mcp serve (stdio) exited before responding to tools/list (code=${raced.info.code ?? "null"} signal=${raced.info.signal ?? "null"})`,
      );
    }
    if (raced.names === null) {
      throw new Error(`mcp serve (stdio) did not respond to tools/list within ${timeoutMs}ms`);
    }
    toolNames = raced.names;

    assertOnlyJsonRpcLines(stdout);
    assertCuratedToolSet(toolNames, expectedToolNames);
  } catch (err) {
    // Attach captured stdio for the caller's diagnostic tail (e.g. boot-smoke's fail() stderr dump).
    if (err && typeof err === "object") {
      err.stdout = stdout;
      err.stderr = stderr;
    }
    throw err;
  } finally {
    try {
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
    } catch {
      // ESRCH: already exited.
    }
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, shutdownTimeoutMs)),
    ]);
    try {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    } catch {
      // ESRCH: already exited.
    }
    cleanupDirs();
  }

  return { toolNames, stdout, stderr };
}
