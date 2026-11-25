import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { parseCodexTranscript } from "./codex.ts";
import type { TranscriptPart } from "./types.ts";

// Oracle: the independent review's concrete empty-result regression and the owner's never-invent
// rule. Tests were authored against the reviewed head before the fix, without reading its source.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/codex-chat/boundaries/${name}.jsonl`, import.meta.url), "utf8");
type ToolPart = Extract<TranscriptPart, { kind: "tool" }>;
const toolsIn = (source: string) => parseCodexTranscript(source).flatMap((entry) => entry.parts).filter((part): part is ToolPart => part.kind === "tool");

function sourceScript(source: string): string {
  const row: unknown = JSON.parse(source.split("\n")[0]!);
  if (typeof row !== "object" || row === null || !("payload" in row)) throw new Error("the fixture must start with its custom call");
  const payload = row.payload;
  if (typeof payload !== "object" || payload === null || !("input" in payload) || typeof payload.input !== "string") throw new Error("the fixture must carry its exact source input");
  return payload.input;
}

describe("@oracle:requirement Code Mode empty text preserves an explicit process status", () => {
  test.each([
    { name: "empty-seven", exitCode: 7, failed: true },
    { name: "empty-zero", exitCode: 0, failed: false },
  ])("CODEX_CHAT_EMPTY_RESULT $name keeps empty output and its own exit status", ({ name, exitCode, failed }) => {
    const source = fixture(name);
    const parts = toolsIn(source);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.id).toBe(`call_${name.replaceAll("-", "_")}`);
    expect(parts[0]!.call).toMatchObject({ kind: "execute", command: sourceScript(source), exitCode });
    expect(parts[0]!.result?.text).toBe("");
    if (failed) expect(parts[0]!.result?.isError).toBe(true);
    else expect(parts[0]!.result).not.toHaveProperty("isError");
  });
});

describe("@oracle:requirement Code Mode uncertain pairing keeps the original exec card", () => {
  test.each([
    "preamble-only",
    "known-script-unknown-result",
    "unknown-script-known-result",
    "mismatched-count",
  ])("CODEX_CHAT_PAIRING_FALLBACK %s does not guess operations or drop the call", (name) => {
    const source = fixture(name);
    const parts = toolsIn(source);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.name).toBe("exec");
    expect(parts[0]!.id).toBe(`call_${name.replaceAll("-", "_")}`);
    if (parts[0]!.call?.kind === "execute") {
      expect(parts[0]!.call.command).toBe(sourceScript(source));
    }
    if (name === "preamble-only") expect(parts[0]!.result?.text).toContain("Script completed");
  });
});

test("@oracle:requirement CODEX_CHAT_OPERATION_ID the first recorded operation keeps call_id and exitCode stays execute-only", () => {
  const parts = toolsIn(fixture("known-batch"));
  expect(parts).toHaveLength(2);
  expect(parts[0]!.id).toBe("call_known_batch");
  expect(parts[0]!.call).toMatchObject({ kind: "execute", command: "printf ok", exitCode: 0 });
  expect(parts[1]!.id).not.toBe(parts[0]!.id);
  expect(parts[1]!.call).toMatchObject({ kind: "edit", path: "/repo/demo.txt", added: 1, removed: 1 });
  expect(parts[1]!.call).not.toHaveProperty("exitCode");
});
