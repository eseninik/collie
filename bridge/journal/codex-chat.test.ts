import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { parseCodexTranscript } from "./codex.ts";
import { parseClaudeTranscript } from "./claude.ts";
import type { TranscriptPart } from "./types.ts";

// Oracle: task 4, steps 1–3 and Addenda 1–2. The source fixtures are independently authored
// requirement examples. The 0.169 image output-list shape was checked in an actual rollout
// before implementation. These tests do not derive expectations from the parser implementation.
const raw = (harness: "claude" | "codex") => readFileSync(new URL(`./fixtures/codex-chat/${harness}-reference.jsonl`, import.meta.url), "utf8");
const parts = () => parseCodexTranscript(raw("codex")).flatMap((entry) => entry.parts);
type ToolPart = Extract<TranscriptPart, { kind: "tool" }>;
function tool(id: string): ToolPart {
  const found = parts().find((part): part is ToolPart => part.kind === "tool" && part.id === id);
  if (found === undefined) throw new Error(`fixture tool ${id} did not reach the journal`);
  return found;
}

describe("@oracle:requirement Codex chat uses the data present in the journal", () => {
  test("CODEX_CHAT_SPEECH keeps the user's words, Markdown and the record's timestamp", () => {
    const entries = parseCodexTranscript(raw("codex"));
    expect(entries[0]).toMatchObject({ role: "user", ts: "2026-11-14T10:00:00.000Z" });
    expect(entries[0]!.parts).toContainEqual({ kind: "text", text: "Сделай приветствие и проверь результат." });
    const reference = parseClaudeTranscript(raw("claude")).flatMap((entry) => entry.parts).find((part) => part.kind === "text" && part.text.startsWith("## Проверка"));
    expect(parts()).toContainEqual(reference);
  });

  test("CODEX_CHAT_COMMAND reads cmd and unwraps the explicit process-output envelope", () => {
    const part = tool("call_shell");
    expect(part.call).toMatchObject({ kind: "execute", command: 'printf "Hello\\n"', exitCode: 0 });
    expect(part.result?.text).toBe(Array.from({ length: 80 }, (_, index) => `output line ${String(index + 1).padStart(3, "0")}`).join("\n"));
    expect(part.result?.text).not.toContain("Chunk ID:");
  });

  test("CODEX_CHAT_EDIT reads the path and changed lines from apply_patch's actual input", () => {
    const call = tool("call_edit").call;
    expect(call).toMatchObject({ kind: "edit", path: "src/greeting.ts", added: 1, removed: 1 });
    if (call?.kind !== "edit") throw new Error("an explicit file patch must make an edit card");
    expect(call.diff?.flatMap((hunk) => hunk.lines)).toEqual([
      '-export const greeting = "Hi";',
      '+export const greeting = "Hello";',
    ]);
  });

  test("CODEX_CHAT_ERROR preserves an explicitly nonzero exit code and marks the fault", () => {
    const part = tool("call_error");
    expect(part.call).toMatchObject({ kind: "execute", command: "false", exitCode: 7 });
    expect(part.result).toMatchObject({ text: "verification failed", isError: true });
  });

  test("CODEX_CHAT_THINKING exposes a visible summary, never encrypted-only reasoning", () => {
    expect(parts()).toContainEqual({ kind: "thinking", text: "Проверю файл перед изменением." });
    expect(parseCodexTranscript(JSON.stringify({ timestamp: "2026-11-14T10:01:00.000Z", type: "response_item", payload: { type: "reasoning", summary: [], content: null, encrypted_content: "private-encrypted-content" } }))).toEqual([]);
  });

  test("CODEX_CHAT_IMAGES keeps pasted image bytes and the image returned by view_image", () => {
    const source = JSON.parse(raw("codex").split("\n")[1]!) as { payload: { content: { type: string; image_url?: string }[] } };
    const url = source.payload.content.find((part) => part.type === "input_image")?.image_url;
    expect(url).toStartWith("data:image/png;base64,");
    expect(parseCodexTranscript(raw("codex"))[0]!.parts).toContainEqual({ kind: "image", url, mimeType: "image/png" });
    expect(tool("call_image").result?.imageUrl).toBe(url);
  });

  test("CODEX_CHAT_IMAGE_SAFETY rejects remote image URLs rather than issuing a request", () => {
    const source = raw("codex").replaceAll(/data:image\/png;base64,[A-Za-z0-9+/=]+/g, "https://untrusted.invalid/pixel.png");
    const parsed = parseCodexTranscript(source).flatMap((entry) => entry.parts);
    expect(parsed.filter((part) => part.kind === "image")).toEqual([]);
    expect(parsed.filter((part) => part.kind === "tool").map((part) => part.result?.imageUrl)).not.toContain("https://untrusted.invalid/pixel.png");
  });

  test("CODEX_CHAT_UNKNOWN leaves status absent when the journal does not supply one", () => {
    const records = [
      { type: "function_call", call_id: "no_status", name: "exec_command", arguments: '{"cmd":"check"}' },
      { type: "function_call_output", call_id: "no_status", output: "ordinary output, no process status" },
    ].map((payload) => JSON.stringify({ timestamp: "2026-11-14T10:02:00.000Z", type: "response_item", payload }));
    const part = parseCodexTranscript(records.join("\n"))[0]!.parts[0]!;
    if (part.kind !== "tool") throw new Error("the call must stay a tool");
    expect(part.call).not.toHaveProperty("exitCode");
    expect(part.result).not.toHaveProperty("isError");
  });
});

// This fixture was captured with the installed 0.169 CLI at low effort in the task's empty probe
// folder. The expected visible operations come directly from its tool input and recorded outputs.
describe("@oracle:requirement real Codex 0.169 Code Mode", () => {
  const captured = () => parseCodexTranscript(readFileSync(new URL("./fixtures/codex-chat/codex-0169-captured.jsonl", import.meta.url), "utf8")).flatMap((entry) => entry.parts);

  test("CODEX_CHAT_CODEMODE exposes the five statically recorded operations as cards", () => {
    const calls = captured().filter((part): part is ToolPart => part.kind === "tool");
    expect(calls).toHaveLength(5);
    const commands = calls.flatMap((part) => part.call?.kind === "execute" ? [part.call] : []);
    expect(commands).toHaveLength(3);
    expect(commands.some((call) => call.command.includes("seq 1 45"))).toBe(true);
    expect(commands.some((call) => call.command.includes("demo.txt"))).toBe(true);
    expect(commands.find((call) => call.command === "exit 7")?.exitCode).toBe(7);
    expect(calls.find((part) => part.call?.kind === "execute" && part.call.command === "exit 7")?.result?.isError).toBe(true);
    const output = calls.find((part) => part.call?.kind === "execute" && part.call.command.includes("seq 1 45"))?.result?.text;
    expect(output).toContain("1. Sample output");
    expect(output).toContain("45. Sample output");
    expect(output).not.toContain('"chunk_id"');
    const patch = calls.find((part) => part.call?.kind === "edit")?.call;
    expect(patch).toMatchObject({ kind: "edit", path: "/repo/demo.txt", added: 1, removed: 1 });
    if (patch?.kind !== "edit") throw new Error("captured patch did not reach an edit card");
    expect(patch.diff?.flatMap((hunk) => hunk.lines)).toEqual(["-old", "+new"]);
    expect(calls.some((part) => part.result?.imageUrl?.startsWith("data:image/png;base64,"))).toBe(true);
  });

  test.each([
    ['a quoted mention', 'text("tools.exec_command({cmd: \\"false\\"})");'],
    ['a commented call', '// text(await tools.exec_command({cmd:"false"}));\ntext("a note");'],
    ['a dynamic argument', 'const cmd = getCommand(); text(await tools.exec_command({cmd}));'],
    ['a conditional call', 'if (choose()) text(await tools.exec_command({cmd:"false"}));'],
  ])("CODEX_CHAT_CODEMODE_UNKNOWN %s never invents a command/result pair", (_label, input) => {
    const records = [
      { type: "custom_tool_call", call_id: "unknown_exec", name: "exec", input },
      { type: "custom_tool_call_output", call_id: "unknown_exec", output: [{ type: "input_text", text: '{"exit_code":7,"output":"recorded text"}' }] },
    ].map((payload) => JSON.stringify({ timestamp: "2026-11-14T10:03:00.000Z", type: "response_item", payload }));
    const parsed = parseCodexTranscript(records.join("\n")).flatMap((entry) => entry.parts);
    const cards = parsed.filter((part): part is ToolPart => part.kind === "tool");
    expect(cards).toHaveLength(1);
    // A raw Code Mode card may use execute as its generic kind; only a fabricated inner shell
    // command would misstate the log. Keep the whole source, with no guessed per-command status.
    if (cards[0]!.call?.kind === "execute") {
      expect(cards[0]!.call.command).toBe(input);
      expect(cards[0]!.call).not.toHaveProperty("exitCode");
    }
    expect(cards[0]!.result?.text).toContain("recorded text");
  });
});
