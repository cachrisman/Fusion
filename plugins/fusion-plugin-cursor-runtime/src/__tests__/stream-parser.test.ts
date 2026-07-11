import { describe, expect, it } from "vitest";
import { extractMessageText, parseCursorLine } from "../stream-parser.js";
import type { CursorAssistantEvent, CursorResultEvent } from "../types.js";

describe("parseCursorLine", () => {
  it("parses a system/init event", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      apiKeySource: "login",
      cwd: "/private/tmp/work",
      session_id: "sess-1",
      model: "Auto",
      permissionMode: "default",
    });
    const event = parseCursorLine(line);
    expect(event).toEqual({
      type: "system",
      subtype: "init",
      apiKeySource: "login",
      cwd: "/private/tmp/work",
      session_id: "sess-1",
      model: "Auto",
      permissionMode: "default",
    });
  });

  it("parses a user event and extracts message text", () => {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
      session_id: "sess-1",
    });
    const event = parseCursorLine(line);
    expect(event?.type).toBe("user");
    expect(extractMessageText(event as any)).toBe("hello");
  });

  it("parses a thinking delta event", () => {
    const line = JSON.stringify({
      type: "thinking",
      subtype: "delta",
      text: "reasoning...",
      session_id: "sess-1",
      timestamp_ms: 123,
    });
    const event = parseCursorLine(line);
    expect(event).toMatchObject({ type: "thinking", subtype: "delta", text: "reasoning..." });
  });

  it("parses a thinking completed event (no text field)", () => {
    const line = JSON.stringify({ type: "thinking", subtype: "completed", session_id: "sess-1" });
    const event = parseCursorLine(line);
    expect(event).toMatchObject({ type: "thinking", subtype: "completed" });
  });

  it("parses an assistant event and extracts message text", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "PONG" }] },
      session_id: "sess-1",
    });
    const event = parseCursorLine(line) as CursorAssistantEvent;
    expect(event.type).toBe("assistant");
    expect(extractMessageText(event)).toBe("PONG");
  });

  it("parses a successful result event with usage", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      duration_ms: 4313,
      is_error: false,
      result: "PONG",
      session_id: "sess-1",
      usage: { inputTokens: 11322, outputTokens: 39, cacheReadTokens: 5941, cacheWriteTokens: 0 },
    });
    const event = parseCursorLine(line) as CursorResultEvent;
    expect(event.type).toBe("result");
    expect(event.is_error).toBe(false);
    expect(event.usage).toEqual({ inputTokens: 11322, outputTokens: 39, cacheReadTokens: 5941, cacheWriteTokens: 0 });
  });

  it("parses an is_error:true result event", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      error: "something failed",
      session_id: "sess-1",
    });
    const event = parseCursorLine(line) as CursorResultEvent;
    expect(event.type).toBe("result");
    expect(event.is_error).toBe(true);
    expect(event.error).toBe("something failed");
  });

  it("tolerates a malformed/garbage line by returning null", () => {
    expect(parseCursorLine("not json at all")).toBeNull();
    expect(parseCursorLine("cursor-retrieval: tracing to '/tmp/x.log'")).toBeNull();
    expect(parseCursorLine("{not valid json")).toBeNull();
  });

  it("tolerates an empty line by returning null", () => {
    expect(parseCursorLine("")).toBeNull();
    expect(parseCursorLine("   ")).toBeNull();
  });

  it("returns null for a result event missing the is_error discriminator", () => {
    const line = JSON.stringify({ type: "result", subtype: "success", result: "x" });
    expect(parseCursorLine(line)).toBeNull();
  });

  it("returns null for an unrecognized type value", () => {
    const line = JSON.stringify({ type: "control_request", request_id: "1" });
    expect(parseCursorLine(line)).toBeNull();
  });

  it("returns null for a JSON array line", () => {
    expect(parseCursorLine("[1,2,3]")).toBeNull();
  });
});
