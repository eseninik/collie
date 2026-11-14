// Codex tool records as the journal's shared cards. No code or path from a rollout is executed.
import type { JsonObject, JsonValue } from "../json.ts";
import { parseUnifiedDiff } from "./diff.ts";
import { resolveImage } from "./pi.ts";
import { clamp, MAX_RESULT_CHARS, stripAnsi } from "./text.ts";
import { classifyToolCall, type ToolCall } from "./tool-call.ts";
import type { TranscriptPart } from "./types.ts";

export type CodexToolPart = Extract<TranscriptPart, { kind: "tool" }>;
type ToolResult = NonNullable<CodexToolPart["result"]>;

function record(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}

export function codexJson(text: string): JsonValue | undefined {
  try {
    // SAFETY: JSON.parse produces JSON values; all property reads remain checked below.
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

/** Only the image bytes/references already in the log. A named local path is never opened here. */
export function codexImage(block: JsonValue): { url: string; mimeType?: string } | { note: string } | null {
  if (!record(block) || block.type !== "input_image" || typeof block.image_url !== "string") return null;
  const image = resolveImage(block.image_url);
  if (image === null || "note" in image) return image;
  const mimeType = /^data:(image\/[\w.+-]+);/i.exec(image.url)?.[1];
  return mimeType === undefined ? image : { url: image.url, mimeType };
}

/** Every loadable picture, and each explicit too-large note, in source order. */
export function codexImages(content: JsonValue | undefined): TranscriptPart[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block): TranscriptPart[] => {
    const image = codexImage(block);
    if (image === null) return [];
    return ["note" in image ? { kind: "text", text: image.note } : { kind: "image", ...image }];
  });
}

interface Output {
  body: string;
  exitCode?: number;
  imageUrl?: string;
}

const PROCESS_OUTPUT = /^Chunk ID: [^\n]*\nWall time: [^\n]*\nProcess exited with code (-?\d+)\nFinal output:\n?([\s\S]*)$/;
const EXEC_PREAMBLE = /^Script (?:completed|running[^\n]*)\nWall time [^\n]*\nOutput:\n?$/;
const EXEC_TRAILER = /^(?:exit_code=)?(\d{1,3})$/;

/** An exit code belongs to an explicit envelope, never a number guessed out of command output. */
function processOutput(text: string): Output {
  const value = codexJson(text);
  if (record(value) && typeof value.output === "string") {
    const metadata = record(value.metadata) ? value.metadata : value;
    const code = metadata.exit_code;
    return typeof code === "number" && Number.isFinite(code)
      ? { body: value.output, exitCode: code }
      : { body: value.output };
  }
  const process = PROCESS_OUTPUT.exec(text);
  return process === null ? { body: text } : { body: process[2] ?? "", exitCode: Number(process[1]) };
}

function textOf(block: JsonValue): string {
  return record(block) && typeof block.text === "string" ? block.text : "";
}

/** A recognized wrapper; its result blocks keep the same order as the recorded straight-line calls. */
export function codexExecEnvelope(raw: JsonValue | undefined): { blocks: JsonValue[]; exitCode?: number } | null {
  if (!Array.isArray(raw) || raw.length < 2 || !EXEC_PREAMBLE.test(textOf(raw[0]!))) return null;
  const trailer = raw.length >= 3 ? EXEC_TRAILER.exec(textOf(raw.at(-1)!)) : null;
  const blocks = raw.slice(1, trailer === null ? undefined : -1);
  const hasOutput = blocks.some((block) => textOf(block) !== "" || codexImage(block) !== null);
  if (!hasOutput) return null;
  return trailer === null ? { blocks } : { blocks, exitCode: Number(trailer[1]) };
}

/** The code-mode preamble/trailer are the wrapper's status, not a nested shell's exit code. */
function blockOutput(blocks: JsonValue[], custom: boolean): Output {
  const envelope = custom ? codexExecEnvelope(blocks) : null;
  const contents = envelope?.blocks ?? blocks;
  const parsed = contents.map(textOf).filter(Boolean).map(processOutput);
  const output: Output = { body: parsed.map((part) => part.body).join("\n") };
  const code = custom ? envelope?.exitCode : parsed.find((part) => part.exitCode !== undefined)?.exitCode;
  if (code !== undefined) output.exitCode = code;
  const images = codexImages(blocks);
  const first = images.find((part) => part.kind === "image");
  if (first?.kind === "image") output.imageUrl = first.url;
  const notes = images.flatMap((part) => part.kind === "text" ? [part.text] : []);
  if (notes.length > 0) output.body = [output.body, ...notes].filter(Boolean).join("\n");
  return output;
}

export function codexOutput(raw: JsonValue | undefined, custom = false): Output {
  if (Array.isArray(raw)) return blockOutput(raw, custom);
  return typeof raw === "string" ? processOutput(raw) : { body: "" };
}

/** The common error/refusal/image fields that the existing Claude cards already render. */
export function codexResult(raw: JsonValue | undefined, custom = false): { result: ToolResult; exitCode?: number } {
  const output = codexOutput(raw, custom);
  const result: ToolResult = clamp(stripAnsi(output.body), MAX_RESULT_CHARS);
  if (/rejected by user|aborted by user/i.test(output.body)) result.denied = true;
  if (output.exitCode !== undefined && output.exitCode !== 0 && !result.denied) result.isError = true;
  if (output.imageUrl !== undefined) result.imageUrl = output.imageUrl;
  return output.exitCode === undefined ? { result } : { result, exitCode: output.exitCode };
}

/** Apply-patch records contain the changed lines themselves, but no absolute line numbers. */
function patchCall(operation: string, path: string, body: string[]): ToolCall[] {
  if (operation === "Delete") return [{ kind: "delete", path }];
  const destination = body.find((line) => line.startsWith("*** Move to: "))?.slice("*** Move to: ".length);
  const diff = parseUnifiedDiff(body.join("\n"));
  const call: ToolCall = { kind: "edit", path: destination ?? path, added: diff.added, removed: diff.removed };
  if (diff.hunks.length > 0) call.diff = diff.hunks;
  if (operation === "Add") call.created = true;
  return destination === undefined ? [call] : [{ kind: "move", path, to: destination }, call];
}

export function codexPatchCalls(patch: string): ToolCall[] {
  if (!patch.startsWith("*** Begin Patch\n") || !patch.trimEnd().endsWith("*** End Patch")) return [];
  const calls: ToolCall[] = [];
  let file: { operation: string; path: string; body: string[] } | undefined;
  for (const line of patch.split("\n").slice(1)) {
    const header = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
    if (header !== null || line === "*** End Patch") {
      if (file !== undefined) calls.push(...patchCall(file.operation, file.path, file.body));
      file = header === null ? undefined : { operation: header[1]!, path: header[2]!, body: [] };
    } else if (file !== undefined) {
      file.body.push(line);
    }
  }
  return calls;
}

export function codexCalls(name: string, input: JsonValue | undefined, summary: string): ToolCall[] {
  const bare = name.replace(/^(?:functions|tools)\./, "");
  if (bare === "apply_patch") {
    const patch = typeof input === "string" ? input : record(input) && typeof input.patch === "string" ? input.patch : "";
    const calls = codexPatchCalls(patch);
    if (calls.length > 0) return calls;
  }
  return [classifyToolCall(bare === "view_image" ? "read" : bare, input, summary)];
}
