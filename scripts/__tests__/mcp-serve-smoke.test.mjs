// FNXC:BootSmoke 2026-07-10-00:00: Regression coverage for the FUSI-013 pure
// JSON-RPC stream validator that backs the `fn mcp serve` stdio boot-smoke
// stage. No subprocess is spawned here — these are captured-string fixtures
// exercising the exact two FUSI-001 runtime regressions:
//   (1) class-1 startup crash — the SDK never resolves, so no `initialize`
//       response is ever written to stdout.
//   (2) class-2 stdout contamination — a `[title-id-drift]` diagnostic (or
//       any other console.log) lands on the JSON-RPC wire.
// Plus a tool-set-drift fixture proving the curated-set comparison rejects
// both a missing and an unexpected tool.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseJsonRpcStream,
  assertOnlyJsonRpcLines,
  extractToolListNames,
  assertCuratedToolSet,
} from "../lib/mcp-smoke.mjs";

const INITIALIZE_RESPONSE = {
  jsonrpc: "2.0",
  id: "fusi-013-initialize",
  result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fn-mcp", version: "0.0.0" } },
};

const CURATED_TOOL_NAMES = ["fn_task_create", "fn_task_list", "fn_task_show", "fn_delegate_task"];

function toolsListResponse(names) {
  return {
    jsonrpc: "2.0",
    id: "fusi-013-tools-list",
    result: { tools: names.map((name) => ({ name, description: "d", inputSchema: { type: "object" } })) },
  };
}

function cleanStdout() {
  return [JSON.stringify(INITIALIZE_RESPONSE), JSON.stringify(toolsListResponse(CURATED_TOOL_NAMES))].join("\n") + "\n";
}

test("fixture 1 (clean stream): accepted with zero stray lines and curated tool set extracted", () => {
  const stdout = cleanStdout();
  assert.doesNotThrow(() => assertOnlyJsonRpcLines(stdout));

  const { messages, strayLines } = parseJsonRpcStream(stdout);
  assert.equal(strayLines.length, 0);
  assert.equal(messages.length, 2);

  const names = extractToolListNames(messages, "fusi-013-tools-list");
  assert.deepEqual(names, [...CURATED_TOOL_NAMES].sort());
  assert.doesNotThrow(() => assertCuratedToolSet(names, CURATED_TOOL_NAMES));
});

test("fixture 2 (class-2 contamination): a stray [title-id-drift] line is rejected and named in the error", () => {
  const strayLine = "[title-id-drift] normalized title for FUSI-001 task migration";
  const stdout = [JSON.stringify(INITIALIZE_RESPONSE), strayLine, JSON.stringify(toolsListResponse(CURATED_TOOL_NAMES))].join(
    "\n",
  ) + "\n";

  const { strayLines } = parseJsonRpcStream(stdout);
  assert.deepEqual(strayLines, [strayLine]);

  assert.throws(() => assertOnlyJsonRpcLines(stdout), (err) => {
    assert.match(err.message, /1 non-JSON-RPC stdout line/);
    assert.match(err.message, /title-id-drift/);
    return true;
  });
});

test("fixture 2b: a human banner / console.log line is also rejected as stray", () => {
  const stdout = "Fusion MCP operator server starting...\n" + JSON.stringify(INITIALIZE_RESPONSE) + "\n";
  assert.throws(() => assertOnlyJsonRpcLines(stdout), /non-JSON-RPC stdout line/);
});

test("fixture 3 (class-1 startup crash): empty/crash-message-only stdout yields no messages and no tools/list response", () => {
  const crashStdout = "Cannot find package '@modelcontextprotocol/sdk' imported from packages/cli/dist/bin.js\n";
  const { messages, strayLines } = parseJsonRpcStream(crashStdout);
  assert.equal(messages.length, 0);
  assert.equal(strayLines.length, 1);

  const names = extractToolListNames(messages, "fusi-013-tools-list");
  assert.equal(names, null, "no tools/list response should ever be found in a startup-crash stream");
});

test("fixture 3b: completely empty stdout also yields no messages (child exited before writing anything)", () => {
  const { messages, strayLines } = parseJsonRpcStream("");
  assert.equal(messages.length, 0);
  assert.equal(strayLines.length, 0);
  assert.equal(extractToolListNames(messages, "fusi-013-tools-list"), null);
});

test("fixture 4 (tool-set drift): missing curated tool is rejected", () => {
  const names = extractToolListNames(
    parseJsonRpcStream(toolsAsStdout(CURATED_TOOL_NAMES.slice(0, -1))).messages,
    "fusi-013-tools-list",
  );
  assert.throws(() => assertCuratedToolSet(names, CURATED_TOOL_NAMES), (err) => {
    assert.match(err.message, /missing: \[fn_delegate_task\]/);
    return true;
  });
});

test("fixture 4b (tool-set drift): unexpected extra tool is rejected", () => {
  const names = extractToolListNames(
    parseJsonRpcStream(toolsAsStdout([...CURATED_TOOL_NAMES, "fn_task_delete"])).messages,
    "fusi-013-tools-list",
  );
  assert.throws(() => assertCuratedToolSet(names, CURATED_TOOL_NAMES), (err) => {
    assert.match(err.message, /unexpected: \[fn_task_delete\]/);
    return true;
  });
});

function toolsAsStdout(names) {
  return JSON.stringify(toolsListResponse(names)) + "\n";
}

test("assertOnlyJsonRpcLines ignores trailing/blank lines", () => {
  const stdout = cleanStdout() + "\n\n   \n";
  assert.doesNotThrow(() => assertOnlyJsonRpcLines(stdout));
});

test("parseJsonRpcStream rejects a JSON array line (not a JSON-RPC object) as stray", () => {
  const stdout = "[1,2,3]\n" + JSON.stringify(INITIALIZE_RESPONSE) + "\n";
  const { strayLines, messages } = parseJsonRpcStream(stdout);
  assert.equal(strayLines.length, 1);
  assert.equal(messages.length, 1);
});
