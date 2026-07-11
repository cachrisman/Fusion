import type { CursorNdjsonEvent } from "./types.js";

const KNOWN_TYPES = new Set(["system", "user", "thinking", "assistant", "result"]);

/*
FNXC:CursorCli 2026-07-11-00:00:
FUSI-063: `cursor-agent -p --output-format stream-json` emits one JSON object
per line (NDJSON) on stdout, plus non-JSON diagnostic lines on STDERR only
(e.g. "cursor-retrieval: tracing to '<tmp log path>'") — never interleaved
into stdout in live capture. This parser is deliberately tolerant: malformed
or unrecognized lines are skipped and never thrown, mirroring the
`fusion-plugin-droid-runtime/src/stream-parser.ts` precedent, so one bad line
never kills the rest of the stream.
*/

/**
 * Parse a single NDJSON line from `cursor-agent` stdout into a typed event.
 * Never throws — empty lines, non-JSON lines, and unrecognized `type` values
 * all return `null` so the streaming pipeline can safely skip and continue.
 */
export function parseCursorLine(line: string): CursorNdjsonEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("{")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== "string" || !KNOWN_TYPES.has(type)) {
    return null;
  }

  if (type === "result" && typeof record.is_error !== "boolean") {
    // `result` events are load-bearing (they terminate the stream) — a
    // malformed one missing the required `is_error` discriminator is
    // treated as unrecognized rather than risking a false-success resolve.
    return null;
  }

  return record as unknown as CursorNdjsonEvent;
}

/** Extract the concatenated text out of a `user`/`assistant` event's `message.content[]`. */
export function extractMessageText(event: { message: { content: Array<{ type: string; text?: string }> } }): string {
  return event.message.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}
