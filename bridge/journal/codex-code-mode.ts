// A deliberately small, non-executing reader for recorded, straight-line Code Mode batches.
// Dynamic expressions, control flow, comments and unpaired output keep the original exec card.
import type { JsonValue } from "../json.ts";
import { codexCalls, codexExecEnvelope, codexJson, codexResult, type CodexToolPart } from "./codex-tools.ts";
import { oneLine } from "./text.ts";

interface Literal {
  value: JsonValue;
  end: number;
}
interface Operation {
  name: string;
  input: JsonValue;
}
const MAX_OPERATIONS = 32;
const MAX_SCRIPT_CHARS = 100_000;
const STRING = /^"(?:[^"\\]|\\.)*"/;

/** JSON literals only. No evaluation, template interpolation, variable lookup or filesystem access. */
function literal(source: string, start: number, object = true): Literal | null {
  const space = /^\s*/.exec(source.slice(start))![0].length;
  const at = start + space;
  if (source[at] === "{") return object ? objectLiteral(source, at) : null;
  const token = STRING.exec(source.slice(at))?.[0] ?? /^(?:-?\d+(?:\.\d+)?|true|false|null)\b/.exec(source.slice(at))?.[0];
  if (token === undefined) return null;
  const value = codexJson(token);
  return value === undefined ? null : { value, end: at + token.length };
}

function objectLiteral(source: string, start: number): Literal | null {
  const fields: [string, JsonValue][] = [];
  let at = start + 1;
  while (fields.length < 32) {
    at += /^\s*/.exec(source.slice(at))![0].length;
    if (source[at] === "}") return { value: Object.fromEntries(fields), end: at + 1 };
    const key = /^([\w$]+|"(?:[^"\\]|\\.)*")\s*:\s*/.exec(source.slice(at));
    if (key === null) return null;
    const name = key[1]!.startsWith('"') ? codexJson(key[1]!) : key[1]!;
    if (typeof name !== "string") return null;
    const parsed = literal(source, at + key[0].length, false);
    if (parsed === null) return null;
    fields.push([name, parsed.value]);
    at = parsed.end + /^\s*/.exec(source.slice(parsed.end))![0].length;
    if (source[at] === ",") at += 1;
    else if (source[at] !== "}") return null;
  }
  return null;
}

function statement(source: string, start: number): { operation: Operation; end: number } | null {
  const input = source.slice(start);
  const printed = /^\s*text\s*\(\s*await\s+tools\.(exec_command|apply_patch)\s*\(/.exec(input);
  const image = /^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+tools\.(view_image)\s*\(/.exec(input);
  const prefix = printed ?? image;
  if (prefix === null) return null;
  const parsed = literal(source, start + prefix[0].length);
  if (parsed === null) return null;
  let suffix: RegExpExecArray | null;
  if (printed !== null) suffix = /^\s*\)\s*\)\s*;?/.exec(source.slice(parsed.end));
  else {
    // Here prefix is the image match; its identifier grammar excludes regexp syntax except $.
    const variable = prefix[1]!.replaceAll("$", "\\$");
    suffix = new RegExp(`^\\s*\\)\\s*;\\s*image\\s*\\(\\s*${variable}\\.image_url\\s*\\)\\s*;?`).exec(source.slice(parsed.end));
  }
  if (suffix === null) return null;
  return { operation: { name: printed === null ? "view_image" : printed[1]!, input: parsed.value }, end: parsed.end + suffix[0].length };
}

function operations(script: string): Operation[] | null {
  if (script.length > MAX_SCRIPT_CHARS) return null;
  const source = script.trimEnd();
  const out: Operation[] = [];
  let at = 0;
  while (at < source.length && out.length < MAX_OPERATIONS) {
    const parsed = statement(source, at);
    if (parsed === null) return null;
    out.push(parsed.operation);
    at = parsed.end;
  }
  return at === source.length && out.length > 0 ? out : null;
}

function operationSummary(operation: Operation): string {
  const input = operation.input;
  if (typeof input === "string") return oneLine(input);
  if (input === null || typeof input !== "object" || Array.isArray(input)) return "";
  const value = input.cmd ?? input.path;
  return typeof value === "string" ? oneLine(value) : "";
}

/** Expand only when the whole batch grammar and the ordered result count agree. */
export function codexCodeModeParts(script: string, raw: JsonValue | undefined, id: string): CodexToolPart[] | null {
  const calls = operations(script);
  const envelope = codexExecEnvelope(raw);
  if (calls === null || envelope === null || calls.length !== envelope.blocks.length) return null;
  const parts: CodexToolPart[] = [];
  for (const [index, operation] of calls.entries()) {
    const block = envelope.blocks[index]!;
    const summary = operationSummary(operation);
    const result = codexResult([block]);
    for (const call of codexCalls(operation.name, operation.input, summary)) {
      if (call.kind === "execute" && result.exitCode !== undefined) call.exitCode = result.exitCode;
      parts.push({ kind: "tool", id: parts.length === 0 ? id : `${id}:${parts.length}`, name: operation.name, summary, call, result: result.result });
    }
  }
  return parts;
}
