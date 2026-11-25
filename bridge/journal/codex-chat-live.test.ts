import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { createCodexReducer, parseCodexTranscript } from "./codex.ts";
import { createLineFeeder } from "./reduce.ts";
import type { TranscriptEntry } from "./types.ts";

const capture = () => readFileSync(new URL("./fixtures/codex-chat/codex-0169-captured.jsonl", import.meta.url), "utf8");

// The same public invariant as reducer-equivalence.test.ts: hold the objects emitted in added,
// because a later result changes them in place and announces their UUID in changed.
function collectRows(rows: readonly string[]) {
  const reducer = createCodexReducer();
  const entries: TranscriptEntry[] = [];
  const changed: string[] = [];
  for (const row of rows) {
    const previous = new Set(entries.map((entry) => entry.uuid));
    const update = reducer.push(row);
    for (const uuid of update.changed) expect(previous.has(uuid)).toBe(true);
    for (const entry of update.added) {
      expect(previous.has(entry.uuid)).toBe(false);
      entries.push(entry);
    }
    changed.push(...update.changed);
  }
  return { entries, changed };
}

function completeRowsFromChunks(source: string, size: number): string[] {
  const feeder = createLineFeeder();
  const rows: string[] = [];
  for (let offset = 0; offset < source.length; offset += size) rows.push(...feeder.push(source.slice(offset, offset + size)));
  rows.push(...feeder.flush());
  return rows;
}

describe("@oracle:property Codex 0.169 live journal invariants", () => {
  test("CODEX_CHAT_STREAM_EQUIVALENCE whole, complete-row and torn-chunk readings agree", () => {
    const source = capture();
    const whole = parseCodexTranscript(source);
    expect(whole.length).toBeGreaterThan(0);
    expect(collectRows(source.split("\n")).entries).toEqual(whole);
    // A one-character split also lands between the two characters of escaped JSON newlines and
    // inside strings. The larger splits vary the boundaries without random or timing dependence.
    for (const size of [1, 17, 251]) expect(collectRows(completeRowsFromChunks(source, size)).entries).toEqual(whole);
  });

  test("CODEX_CHAT_STREAM_CHANGED a late result changes its already emitted entry, without a duplicate", () => {
    const rows = capture().split("\n");
    const callIndex = rows.findIndex((row) => /"type"\s*:\s*"custom_tool_call"/.test(row));
    const outputIndex = rows.findIndex((row) => /"type"\s*:\s*"custom_tool_call_output"/.test(row));
    if (callIndex < 0 || outputIndex <= callIndex) throw new Error("the capture must contain a call followed by its result");
    const reducer = createCodexReducer();
    const held: TranscriptEntry[] = [];
    let callEntry: TranscriptEntry | undefined;
    for (let index = 0; index < outputIndex; index += 1) {
      const update = reducer.push(rows[index]!);
      held.push(...update.added);
      if (index === callIndex) callEntry = update.added.find((entry) => entry.parts.some((part) => part.kind === "tool"));
    }
    if (callEntry === undefined) throw new Error("the live call must be emitted before its result");
    const emittedCall = callEntry;
    expect(emittedCall.parts.filter((part) => part.kind === "tool").every((part) => part.result === undefined)).toBe(true);
    const update = reducer.push(rows[outputIndex]!);
    expect(update.added).toEqual([]);
    expect(update.changed).toContain(emittedCall.uuid);
    expect(new Set(update.changed).size).toBe(update.changed.length);
    expect(held.find((entry) => entry.uuid === emittedCall.uuid)).toBe(emittedCall);
    expect(emittedCall.parts.some((part) => part.kind === "tool" && part.result !== undefined)).toBe(true);
    for (const row of rows.slice(outputIndex + 1)) held.push(...reducer.push(row).added);
    expect(held).toEqual(parseCodexTranscript(capture()));
    expect(new Set(held.map((entry) => entry.uuid)).size).toBe(held.length);
  });
});

test("@oracle:reference CODEX_CHAT_STREAM_CARDS the captured five operations survive a torn live read once each", () => {
  const entries = collectRows(completeRowsFromChunks(capture(), 37)).entries;
  const calls = entries.flatMap((entry) => entry.parts).filter((part) => part.kind === "tool");
  // Independent source: the real capture records three shell operations, one patch and one image.
  expect(calls).toHaveLength(5);
  const ids = calls.map((part) => part.id);
  expect(ids.every((id) => typeof id === "string")).toBe(true);
  expect(new Set(ids).size).toBe(5);
});

describe("@oracle:requirement unknown Code Mode never executes or invents data", () => {
  test.each([
    ["nested unsupported input", 'text(await tools.unknown({nested:{one:{two:{cmd:"false"}}}}));'],
    ["nested dynamic object", 'text(await tools.exec_command({cmd:{nested:{value:(globalThis.__COLLIE_CODEMODE_TEST_CANARY__.value = 1, "false")}}}));'],
  ])("CODEX_CHAT_OBJECT_FALLBACK %s stays one raw card and leaves the reader intact", (_label, input) => {
    const key = "__COLLIE_CODEMODE_TEST_CANARY__";
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    const canary = { value: 0 };
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: canary });
    try {
      const records = [
        { type: "custom_tool_call", call_id: "object_call", name: "exec", input },
        { type: "custom_tool_call_output", call_id: "object_call", output: [{ type: "input_text", text: '{"exit_code":7,"output":"recorded object result"}' }] },
      ].map((payload) => JSON.stringify({ timestamp: "2026-11-14T10:04:00.000Z", type: "response_item", payload }));
      const parsed = parseCodexTranscript(records.join("\n"));
      const calls = parsed.flatMap((entry) => entry.parts).filter((part) => part.kind === "tool");
      expect(canary.value).toBe(0);
      expect(calls).toHaveLength(1);
      if (calls[0]!.call?.kind === "execute") {
        expect(calls[0]!.call.command).toBe(input);
        expect(calls[0]!.call).not.toHaveProperty("exitCode");
      }
      expect(calls[0]!.result?.text).toContain("recorded object result");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, key);
      else Object.defineProperty(globalThis, key, previous);
    }
  });
});
