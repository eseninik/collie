// Codex's journal adapter.
//
// Codex 0.169 was measured again on 2026-11-14 (fixtures/codex-chat). Its image blocks,
// process envelopes, patch inputs and straight-line Code Mode batches feed the shared Claude cards.
// Format-specific decoding lives in codex-tools.ts and codex-code-mode.ts; neither executes input.
//
// SHAPE OF THE SOURCE (verified against on-disk rollouts from codex 0.32.0 AND 0.145.0, 2026-07-29 —
// the path layout and the row envelope are identical across that span; 0.145 adds `world_state` and
// `turn_context` row types, and a `developer` message role, all of which this parser ignores):
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<session-uuid>.jsonl
//   {"timestamp":"…","type":"session_meta","payload":{"id":"<uuid>","cwd":"…","cli_version":"…"}}
//   {"timestamp":"…","type":"response_item","payload":{"type":"message"|"reasoning"|
//                                                      "function_call"|"function_call_output", …}}
//   {"timestamp":"…","type":"event_msg","payload":{"type":"user_message"|"agent_message"|
//                                                  "agent_reasoning"|"token_count", …}}
// `{timestamp,type,payload}` were the ONLY top-level keys up to 0.156; 0.163 adds `ordinal`, a row
// number that counts across the files of one conversation (below). The parser reads none of it.
//
// A REWIND STARTS A NEW FILE (measured on codex 0.163.0, 2026-10-19, issue #523). Esc-Esc, pick an
// earlier prompt, Enter: Codex keeps the session id and writes the rest of the conversation to a
// SEGMENT, `rollout-<ISO-ts>-<session-uuid>_<segment-uuid>.jsonl`, in the date folder of the rewind.
// The old file is never written again. The segment's `session_meta` names what it kept, by pointer:
//   "history_base":{"thread_id":"<session-uuid or an earlier segment-uuid>",
//                   "end_ordinal_exclusive":17,"end_byte_offset":63091}
// The conversation is bytes [0, end_byte_offset) of that base, then the segment. A second rewind
// points at the first segment, so a chain is read newest to oldest. No row is copied, so nothing is
// deduped. See CodexTranscriptSource.
//
// THE TRAP: ROWS ARE DOUBLE-BOOKED. The same conversation is written twice — once as `response_item`
// (the API-shaped record) and once as `event_msg` (the UI event stream). Measured on one session: 29
// `response_item` user messages against 28 `event_msg` user_messages, and the same for assistant
// turns. Parse both families and every turn renders twice. We take `response_item` and drop
// `event_msg` wholesale, because only `response_item` carries tool RESULTS
// (`function_call_output`) — the event stream has the calls' narration but not their output.
//
// Where Herdr's id comes from: Codex's `SessionStart` hook reports `session_id` to
// `pane.report_agent_session` (herdr integration `codex`, version 6), so the pane record carries a
// kind-`id` ref exactly like Claude's. It needs `herdr integration install codex`; without the hook
// there is no id and the journal correctly reports "no-session". The hook fires only when the first
// prompt is submitted, so a Codex pane with no turn yet has no session either
// (`REPORTS_SESSION_ON_FIRST_PROMPT` in `registry.ts`).

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { CacheProbe } from "../cache/engine.ts";
import type { JsonObject, JsonValue } from "../json.ts";
import {
  parseWith,
  createUnknownCounter,
  type KnownTypes,
  type UnknownCounter,
  NO_CHANGE,
  noQueue,
  noteBlockTypes,
  type PendingTool,
  reduction,
  type Reduction,
  rememberPending,
  type RowReducer,
} from "./reduce.ts";
import { asRecord, asText, probeTail, tokenCount, walkBack } from "./cache-probe.ts";
import { asWindow } from "./model-window.ts";
import { type Cursor, NO_CURSOR, type ReadSince } from "./cursor.ts";
import {
  containedRealpath,
  exists,
  FIRST_TAIL_BYTES,
  head,
  loadTail,
  MAX_TRANSCRIPT_BYTES,
  readSinceFile,
  rootReader,
  type RootSource,
  statFile,
} from "./files.ts";
import { clamp, MAX_TEXT_CHARS, oneLine, stripAnsi, summarizeToolInput } from "./text.ts";
import { codexCalls, codexImages, codexJson, codexOutput, codexResult, type CodexToolPart } from "./codex-tools.ts";
import { codexCodeModeParts } from "./codex-code-mode.ts";
import type {
  AgentSessionRef,
  JournalAdapter,
  TranscriptEntry,
  TranscriptPart,
  TranscriptSource,
} from "./types.ts";

/** Codex names sessions with the same canonical uuid shape Claude does. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCodexSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

/**
 * A stable per-row cursor, synthesised because Codex rows carry NO id of their own — and
 * `TranscriptEntry.uuid` is the paging cursor (`?before=`).
 *
 * Row POSITION is the obvious candidate and the wrong one: a log over the byte cap is tail-read, so
 * the window's first row is not the file's first row, and the offset moves as the file grows. Hashing
 * the row's own bytes instead makes the cursor a property of the CONTENT, so it survives a window
 * that starts somewhere else. The occurrence counter disambiguates rows that are byte-identical
 * (two identical shell calls); an unknown cursor degrades to "newest" rather than to an empty page,
 * so the rare miss is a re-render, never a dead end.
 *
 * KNOWN FAILURE MODE, accepted. If a >32 MB log's tail window shifts between two requests AND an
 * earlier byte-identical row falls out of it, the occurrence counters renumber: a cursor the client
 * holds as `cx-<h>-2` can then name what used to be `cx-<h>-3`. That pages to a slightly wrong
 * position rather than degrading to "newest" — the one case where the miss is silent. It needs a
 * multi-megabyte log, duplicate rows identical to the byte, and a window shift between two taps; the
 * harm is a misplaced page in a view you scroll anyway, so it isn't worth a per-row index the format
 * doesn't give us.
 *
 * INVARIANT this relies on: `seen` is advanced for every `response_item` row, INCLUDING rows that
 * emit no entry (a tool output that folds onto its call, an empty reasoning row). Numbering must be a
 * function of the parsed window alone — if it depended on which rows happened to render, adding a
 * renderable row would renumber the ones before it.
 */
export function codexCursor(line: string, seen: Map<string, number>): string {
  // djb2 — we need determinism and speed, not collision resistance; a collision costs a re-render.
  let hash = 5381;
  for (let i = 0; i < line.length; i++) hash = ((hash << 5) + hash + line.charCodeAt(i)) | 0;
  const key = (hash >>> 0).toString(36);
  const n = seen.get(key) ?? 0;
  seen.set(key, n + 1);
  return n === 0 ? `cx-${key}` : `cx-${key}-${n}`;
}

/** Flatten a Codex content list (`input_text` / `output_text` / `text` blocks) into plain text. */
function blockText(content: JsonValue | undefined, separator = "\n"): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      b !== null && typeof b === "object" && !Array.isArray(b) && typeof b.text === "string"
        ? b.text
        : "",
    )
    .filter(Boolean)
    .join(separator);
}

/**
 * Unwrap a `function_call_output.output`, which is a JSON STRING wrapping `{"output": "…"}` rather
 * than the output itself. Falls back to the raw string when it isn't that shape — a tool whose
 * output isn't JSON should still show its output rather than nothing.
 */
export function codexToolOutput(raw: JsonValue | undefined): string {
  return codexOutput(raw).body;
}

/** `arguments` arrives as a JSON string, not an object — parse before summarising. */
function codexToolSummary(args: JsonValue | undefined): string {
  if (typeof args !== "string") return summarizeToolInput(args);
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction.
    return summarizeToolInput(JSON.parse(args) as JsonValue);
  } catch {
    return oneLine(args); // malformed/partial arguments still say something useful
  }
}

/**
 * The same `arguments`, PARSED, for {@link classifyToolCall} — which wants the input as a
 * `JsonValue` and not as the one-line summary above.
 *
 * Malformed arguments yield `undefined`, which the classifier reads as an empty input: a partial
 * write loses the structure, while `codexToolSummary` still falls back to the raw line, so the row
 * keeps its sentence either way.
 */
function codexToolInput(args: JsonValue | undefined): JsonValue | undefined {
  if (typeof args !== "string") return args;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction.
    return JSON.parse(args) as JsonValue;
  } catch {
    return undefined;
  }
}

/**
 * A `custom_tool_call.input`, which is NOT the JSON object `function_call.arguments` is.
 *
 * Measured over 53 `custom_tool_call` rows on this host: `name` is `exec` every time and `input` is
 * the shell script ITSELF, a bare string that never parses as JSON. {@link classifyToolCall} reads an
 * object, so a raw script handed to it straight would classify as an empty execute — the call would
 * render with no command in it. Wrapping it under `script`, one of the three keys that branch already
 * reads, is what makes the command show.
 *
 * A JSON OBJECT is still taken as itself, for the tool codex has not written yet. A parse that yields
 * anything else (a script that happens to read as a bare number) is treated as the script it is.
 */
function codexCustomInput(raw: JsonValue | undefined): JsonValue | undefined {
  if (typeof raw !== "string") return raw;
  const parsed = codexToolInput(raw);
  if (parsed !== null && parsed !== undefined && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  return { script: raw };
}

/** A pending call retains its emitted entry so a recorded Code Mode batch fills its cards in place. */
interface PendingCodexTool extends PendingTool {
  entry: TranscriptEntry;
  script?: string;
}

/**
 * Injected context Codex sends as a user turn. Rendering it as "You" would be actively wrong — the
 * operator never typed it — so it is dropped exactly like Claude's `system-reminder`.
 */
function isInjectedContext(text: string): boolean {
  return text.trimStart().startsWith("<environment_context>");
}

/**
 * Parse a Codex rollout log into oldest-first turns. PURE — no fs, no clock.
 *
 * Unparseable lines are skipped: the log is appended to live, so the last line can be a partial
 * write, and a tail-read window starts mid-line by construction.
 */
export function parseCodexTranscript(text: string): TranscriptEntry[] {
  return parseWith(createCodexReducer(), text);
}

/**
 * Every type this adapter has MET, rendered or dropped (`reduce.ts` § "what a reducer reports about
 * what it could not read"). Anything else is counted and named.
 *
 * Measured on 2026-09-30 over 48 local rollout logs (Codex 0.156.1), which is the whole inventory
 * they carry. TWO LEVELS land in `rows`, because Codex needs two to say what a row IS: the envelope's
 * own `type`, and the `payload.type` inside a `response_item`, which is the field that says whether
 * the item is speech, reasoning or a call. Content blocks land in `parts`: a message's `content`
 * (`input_text` / `output_text`, 596 of them) and reasoning's `summary` (`summary_text`, 202). Both
 * are read by FIELD here — `blockText` takes any block's `.text` — so a new block type would be
 * dropped in silence, which is exactly what this counts.
 *
 * `custom_tool_call` and `custom_tool_call_output` are READ, on the same branch as `function_call`,
 * and they are the shape codex reaches for most: 53 of them against 6 `function_call` on this host.
 * They were listed here while they were dropped, which is why the tally never counted them.
 *
 * `developer` is the one role that matters here: Codex writes three of those rows, carrying injected
 * system prompts, before the first real turn, and rendering one as speech would put words in the
 * operator's mouth (see the `message` branch).
 */
const CODEX_KNOWN: KnownTypes = {
  rows: [
    // The envelope.
    "response_item",
    "event_msg",
    "token_usage_record",
    "turn_context",
    "session_meta",
    "world_state",
    // Codex 0.159's context compaction (harness canary 2026-10-12): the hand-off text for the next
    // window and the history it keeps. The turns it summarises stay on screen from their own rows.
    "compacted",
    // What a `response_item` carries.
    "message",
    "reasoning",
    "function_call",
    "function_call_output",
    "custom_tool_call",
    "custom_tool_call_output",
    // 0.169 records tool definitions here, not a conversation turn.
    "additional_tools",
  ],
  roles: ["user", "assistant", "developer"],
  parts: ["input_text", "output_text", "text", "summary_text", "input_image"],
};

interface CodexState {
  // Content-derived occurrence counters must live for the whole parsed window (codexCursor).
  seen: Map<string, number>;
  // This map is bounded by rememberPending, just like the other journal adapters.
  pendingTools: Map<string, PendingCodexTool>;
  unknown: UnknownCounter;
}
interface CodexItem {
  payload: JsonObject;
  uuid: string;
  ts: string;
}

/** Admission and unknown-type accounting happen once, including for rows that emit no entry. */
function readCodexItem(state: CodexState, line: string): CodexItem | null {
  const row = asRecord(codexJson(line));
  if (row === null) return null;
  state.unknown.row(row.type);
  // The UI event stream duplicates these records, so it is deliberately not parsed as speech.
  if (row.type !== "response_item") return null;
  const payload = asRecord(row.payload);
  if (payload === null) return null;
  state.unknown.row(payload.type);
  noteBlockTypes(state.unknown, payload.content);
  noteBlockTypes(state.unknown, payload.summary);
  noteBlockTypes(state.unknown, payload.output);
  return { payload, uuid: codexCursor(line, state.seen), ts: typeof row.timestamp === "string" ? row.timestamp : "" };
}

function codexMessageParts(content: JsonValue | undefined, body: string): TranscriptPart[] {
  const parts: TranscriptPart[] = [];
  if (body.trim() !== "") parts.push({ kind: "text", ...clamp(body, MAX_TEXT_CHARS) });
  parts.push(...codexImages(content));
  return parts;
}

function codexMessage(state: CodexState, item: CodexItem): Reduction {
  const p = item.payload;
  state.unknown.role(p.role);
  // Injected developer/system text is plumbing, not something the operator said.
  if (p.role !== "user" && p.role !== "assistant") return NO_CHANGE;
  const body = stripAnsi(blockText(p.content));
  if (p.role === "user" && isInjectedContext(body)) return NO_CHANGE;
  const parts = codexMessageParts(p.content, body);
  return parts.length === 0 ? NO_CHANGE : reduction([{ uuid: item.uuid, ts: item.ts, role: p.role, parts }], new Set());
}

function codexReasoning(item: CodexItem): Reduction {
  // Only visible summaries. An encrypted-only record supplies no text to display.
  const summary = Array.isArray(item.payload.summary) ? blockText(item.payload.summary, "\n\n") : "";
  if (summary.trim() === "") return NO_CHANGE;
  return reduction([{ uuid: item.uuid, ts: item.ts, role: "assistant", parts: [{ kind: "thinking", ...clamp(stripAnsi(summary), MAX_TEXT_CHARS) }] }], new Set());
}

function codexCallParts(p: JsonObject, name: string, raw: JsonValue | undefined): CodexToolPart[] {
  const custom = p.type === "custom_tool_call";
  const input = custom && name === "apply_patch" ? raw : custom ? codexCustomInput(raw) : codexToolInput(raw);
  const summary = codexToolSummary(raw);
  return codexCalls(name, input, summary).map((call, index) => {
    const part: CodexToolPart = { kind: "tool", name, summary, call };
    if (typeof p.call_id === "string") part.id = index === 0 ? p.call_id : `${p.call_id}:${index}`;
    return part;
  });
}

function codexCall(state: CodexState, item: CodexItem): Reduction {
  const p = item.payload;
  const name = typeof p.name === "string" ? p.name : "tool";
  const raw = p.type === "custom_tool_call" ? p.input : p.arguments;
  const parts = codexCallParts(p, name, raw);
  const entry: TranscriptEntry = { uuid: item.uuid, ts: item.ts, role: "assistant", parts };
  if (typeof p.call_id === "string") {
    const pending: PendingCodexTool = { part: parts[0]!, uuid: item.uuid, entry };
    if (p.type === "custom_tool_call" && name === "exec" && typeof raw === "string") pending.script = raw;
    rememberPending(state.pendingTools, p.call_id, pending);
  }
  return reduction([entry], new Set());
}

function fillCodexCall(target: PendingCodexTool, raw: JsonValue | undefined, custom: boolean, id: string): void {
  const expanded = target.script === undefined ? null : codexCodeModeParts(target.script, raw, id);
  if (expanded !== null) {
    target.entry.parts = expanded;
    return;
  }
  const folded = codexResult(raw, custom);
  for (const part of target.entry.parts) {
    if (part.kind !== "tool") continue;
    part.result = folded.result;
    if (part.call?.kind === "execute" && folded.exitCode !== undefined) part.call.exitCode = folded.exitCode;
  }
}

function codexResultRow(state: CodexState, item: CodexItem): Reduction {
  const p = item.payload;
  const id = typeof p.call_id === "string" ? p.call_id : "";
  const target = state.pendingTools.get(id);
  const custom = p.type === "custom_tool_call_output";
  if (target !== undefined) {
    state.pendingTools.delete(id);
    fillCodexCall(target, p.output, custom, id);
    return reduction([], new Set([target.uuid]));
  }
  const { result } = codexResult(p.output, custom);
  if (result.text.trim() === "" && result.imageUrl === undefined) return NO_CHANGE;
  // A tail may start at the result: keep its output/image without inventing the missing call.
  return reduction([{ uuid: item.uuid, ts: item.ts, role: "assistant", parts: [{ kind: "tool", name: "result", summary: "", result }] }], new Set());
}

function reduceCodex(state: CodexState, line: string): Reduction {
  const item = readCodexItem(state, line);
  if (item === null) return NO_CHANGE;
  switch (item.payload.type) {
    case "message": return codexMessage(state, item);
    case "reasoning": return codexReasoning(item);
    case "function_call":
    case "custom_tool_call": return codexCall(state, item);
    case "function_call_output":
    case "custom_tool_call_output": return codexResultRow(state, item);
    default: return NO_CHANGE;
  }
}

/** The same reading one row at a time, with result mutations reported to the live chat window. */
export function createCodexReducer(): RowReducer {
  const state: CodexState = { seen: new Map(), pendingTools: new Map(), unknown: createUnknownCounter(CODEX_KNOWN) };
  return { push: (line) => reduceCodex(state, line), unknowns: state.unknown.tally, queued: noQueue };
}

/**
 * How long a resolved path is trusted before {@link CodexTranscriptSource.resolve} looks for a newer
 * segment. A rewind moves the conversation to a new file under the SAME session id, so the cache can
 * no longer hold a hit for good. Every poll asks (the cache probe, the tracker, the Chat window), and
 * a walk per ask is a readdir per date folder per pane, so the walk runs at most once per this long.
 * The cost is that Chat follows a rewind up to this late.
 */
export const CODEX_RESCAN_MS = 2000;

/** Most links of a rewind chain followed. A chain past it reads as clipped, not as an error. */
export const CODEX_MAX_CHAIN = 64;

/** The most of a file read to find its `session_meta` row. Measured: 19 KB on 0.163.0. */
const META_BYTES = 256 * 1024;

/** One file of a conversation, and how many of its bytes belong to it: `[0, end)`. */
interface ChainLink {
  readonly path: string;
  readonly end: number;
}

/** Where a segment's retained history lives, read off its `session_meta.history_base`. */
interface HistoryBase {
  readonly id: string;
  readonly end: number;
}

/**
 * The pointer in a `session_meta` row, or null for anything else.
 *
 * The id is checked against the uuid shape BEFORE it can become part of a file name, exactly as a
 * Herdr id is: the file is Codex's, but a name built from its contents is still a name built.
 */
export function codexHistoryBase(firstLine: string): HistoryBase | null {
  let row: JsonValue;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction.
    row = JSON.parse(firstLine) as JsonValue;
  } catch {
    return null;
  }
  const meta = asRecord(row);
  if (meta === null || meta.type !== "session_meta") return null;
  const base = asRecord(asRecord(meta.payload)?.history_base);
  if (base === null) return null;
  const id = base.thread_id;
  const end = base.end_byte_offset;
  if (typeof id !== "string" || !isCodexSessionId(id)) return null;
  if (typeof end !== "number" || !Number.isSafeInteger(end) || end < 0) return null;
  return { id: id.toLowerCase(), end };
}

/**
 * Real filesystem source rooted at Codex's `sessions` directory.
 *
 * Resolution is a targeted walk rather than Claude's flat scan, because the uuid is in the FILENAME
 * under date-partitioned directories (`YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`). We walk newest-date
 * first, so a live session is found after reading a handful of directory entries rather than the
 * whole year.
 *
 * THE ACTIVE FILE IS THE NEWEST ONE OF THE SESSION. Herdr cannot say which file it is: Codex's hook
 * reports the session id, and a rewind keeps that id (file header), so the pane record reads the same
 * before and after. What does change is the file set: a rewind adds a segment and never writes the
 * old file again. So `resolve` answers the newest file whose name carries the session id, the plain
 * one or a `_<segment>` one. Newest is the largest name in the newest date folder that has one: the
 * name starts with the time to the second, and two segments in one second are told apart by their
 * uuids, which are time-ordered (v7). A hit is trusted for {@link CODEX_RESCAN_MS}, then walked again.
 *
 * THE CONVERSATION IS A CHAIN. The active segment holds only what came after the rewind; `load` and a
 * resetting `readSince` put the retained history in front of it, by following `history_base`
 * pointers to the session's own files ({@link CODEX_MAX_CHAIN} links, a file seen twice ends it). The
 * key stays the active file's path and its `stat` stays the active file's, which is right because a
 * base is frozen: the only thing that changes a conversation's prefix is another rewind, and that
 * changes the path.
 *
 * No continuation-following beyond that: Codex reports its session on the `SessionStart` hook (which
 * fires only at the first prompt, see `REPORTS_SESSION_ON_FIRST_PROMPT` in `registry.ts`), so a
 * resumed conversation re-reports its NEW id and the pane record follows it.
 */
export class CodexTranscriptSource implements TranscriptSource {
  private readonly pathCache = new Map<string, { path: string; at: number }>();

  private readonly rootsNow: () => string[];

  /** The roots now: fixed, or the live list an added account joins (M101). */
  private get roots(): string[] {
    return this.rootsNow();
  }

  /** One sessions directory or several (a second `CODEX_HOME`), searched in order. */
  constructor(
    roots: RootSource,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.rootsNow = rootReader(roots);
  }

  async resolve(ref: AgentSessionRef): Promise<string | null> {
    if (ref.kind !== "id" || !isCodexSessionId(ref.value)) return null;
    const sessionId = ref.value.toLowerCase();
    const cached = this.pathCache.get(sessionId);
    if (cached !== undefined && this.now() - cached.at < CODEX_RESCAN_MS && (await exists(cached.path))) {
      return cached.path;
    }
    this.pathCache.delete(sessionId);

    // The id is uuid-shaped (checked above), so it is safe inside a pattern.
    const own = new RegExp(`-${sessionId}(?:_[0-9a-f-]{36})?\\.jsonl$`);
    for (const root of this.roots) {
      const hit = await this.findUnder(root, (name) => own.test(name));
      // A hit that failed containment is `null` too — that root has nothing it may serve for this
      // uuid either way, and the next root is asked on its own terms (files.ts header).
      if (hit === null) continue;
      this.pathCache.set(sessionId, { path: hit, at: this.now() });
      return hit;
    }
    return null;
  }

  /**
   * The newest file under `root` whose name `match` accepts: newest date folder first, and the
   * largest name inside the first folder that has one.
   */
  private async findUnder(root: string, match: (lowerName: string) => boolean): Promise<string | null> {
    for (const year of await descending(root)) {
      for (const month of await descending(join(root, year))) {
        for (const day of await descending(join(root, year, month))) {
          const dir = join(root, year, month, day);
          let names: string[];
          try {
            names = await readdir(dir);
          } catch {
            continue;
          }
          const hit = names
            .filter((n) => n.startsWith("rollout-") && match(n.toLowerCase()))
            .toSorted()
            .at(-1);
          if (hit === undefined) continue;
          return containedRealpath(join(dir, hit), root);
        }
      }
    }
    return null;
  }

  /**
   * The file a `history_base` names: the session's plain file when the id is the session's own, its
   * `_<segment>` file otherwise. Looked up in every root, contained by the root that answered.
   */
  private async findBase(sessionId: string, baseId: string): Promise<string | null> {
    const suffix = baseId === sessionId ? `-${sessionId}.jsonl` : `-${sessionId}_${baseId}.jsonl`;
    for (const root of this.roots) {
      const hit = await this.findUnder(root, (name) => name.endsWith(suffix));
      if (hit !== null) return hit;
    }
    return null;
  }

  /**
   * The files in front of `active`, newest first, and whether the chain reached a file with no
   * pointer. `broken` is a base that is gone, a loop, or a chain past {@link CODEX_MAX_CHAIN}: the
   * caller shows what it has and calls it clipped, as it does a log over the byte cap.
   */
  private async chain(active: string, firstLine: string): Promise<{ links: ChainLink[]; broken: boolean }> {
    const sessionId = /-([0-9a-f-]{36})(?:_[0-9a-f-]{36})?\.jsonl$/i.exec(active)?.[1]?.toLowerCase();
    const links: ChainLink[] = [];
    if (sessionId === undefined) return { links, broken: false };
    const seen = new Set([active]);
    let base = codexHistoryBase(firstLine);
    while (base !== null) {
      if (links.length >= CODEX_MAX_CHAIN) return { links, broken: true };
      const path = await this.findBase(sessionId, base.id);
      if (path === null || seen.has(path)) return { links, broken: true };
      seen.add(path);
      const st = await statFile(path);
      if (st === null) return { links, broken: true };
      links.push({ path, end: Math.min(base.end, st.size) });
      base = codexHistoryBase(await firstLineOf(path));
    }
    return { links, broken: false };
  }

  /**
   * The retained history in front of `active`, as whole rows, at most `budget` bytes of it.
   *
   * Over the budget the OLDEST end is cut, as {@link loadTail} cuts a long log, and the cut row is
   * dropped rather than handed on as a fragment. `complete` is false then, and when the chain broke.
   */
  private async prefix(
    active: string,
    firstLine: string,
    budget: number,
  ): Promise<{ text: string; complete: boolean }> {
    const { links, broken } = await this.chain(active, firstLine);
    const parts: string[] = [];
    let left = Math.max(0, budget);
    for (const link of links) {
      const take = Math.min(link.end, left);
      let text = take === 0 ? "" : await Bun.file(link.path).slice(link.end - take, link.end).text();
      // The pointer names a row boundary; a cut that is not on one keeps only the whole rows.
      const last = text.lastIndexOf("\n");
      text = last === -1 ? "" : text.slice(0, last + 1);
      const cut = take < link.end;
      if (cut) text = text.slice(text.indexOf("\n") + 1);
      parts.unshift(text);
      left -= take;
      if (cut) return { text: parts.join(""), complete: false };
    }
    return { text: parts.join(""), complete: !broken };
  }

  stat = statFile;

  /** The History read: the retained history, then the active file, under the one byte cap. */
  load = async (path: string): Promise<{ text: string; complete: boolean; size: number; mtimeMs: number }> => {
    const tail = await loadTail(path);
    if (!tail.complete) return tail;
    const before = await this.prefix(path, firstLineIn(tail.text), MAX_TRANSCRIPT_BYTES - tail.size);
    return { ...tail, text: before.text + tail.text, complete: before.complete };
  };

  /**
   * The live read, with one contract on its caller that no other harness imposes.
   *
   * A RESET MUST BE PAIRED WITH A FRESH REDUCER HERE. {@link codexCursor} numbers byte-identical
   * rows by occurrence, and that numbering is a property of the parsed window — which is stated as
   * an invariant where it is synthesised. A reset moves the window, so the numbering restarts, and a
   * reducer kept across one would carry `seen` counts for rows the caller has thrown away. Under an
   * append nothing renumbers, because the window only grows at the end.
   *
   * That is not a defect of the cursor, it is what `reset` means: the answer replaces what you hold,
   * uuids included.
   *
   * A reset that read the active file from byte 0 also carries the retained history in front, inside
   * the same first-read bound, so Chat opens on the turns a rewind kept. The cursor still counts bytes
   * of the active file only; an append never needs the prefix again, because a base never changes.
   */
  readSince = async (key: string, cursor: Cursor): Promise<ReadSince> => {
    const read = await readSinceFile(key, cursor);
    if (!read.reset || !read.fromStart) return read;
    // An active file with no whole row yet: hold no position, so the read that finds its first row is
    // a reset again and carries the prefix. An append would never fetch it.
    if (read.lines.length === 0) return { ...read, cursor: NO_CURSOR };
    const used = Buffer.byteLength(read.lines.join("\n")) + 1;
    const before = await this.prefix(key, read.lines[0] ?? "", FIRST_TAIL_BYTES - used);
    if (before.text === "") return { ...read, fromStart: before.complete };
    const rows = before.text.slice(0, -1).split("\n");
    return { ...read, lines: [...rows, ...read.lines], fromStart: before.complete };
  };
}

/** The first row of a text, without its newline. */
function firstLineIn(text: string): string {
  const end = text.indexOf("\n");
  return end === -1 ? text : text.slice(0, end);
}

/** The first row of a file — its `session_meta` — read within {@link META_BYTES}. */
async function firstLineOf(path: string): Promise<string> {
  try {
    return firstLineIn(await head(path, META_BYTES));
  } catch {
    return "";
  }
}

/** Directory entries, newest-name first. Empty when the directory doesn't exist. */
async function descending(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).toSorted().toReversed();
  } catch {
    return [];
  }
}

/** Codex's journal adapter. `agent` matches the Herdr snapshot's `agent` string. */
export function codexJournal(roots: RootSource): JournalAdapter {
  const source = new CodexTranscriptSource(roots);
  return {
    agent: "codex",
    source,
    parse: parseCodexTranscript,
    reducer: createCodexReducer,
    cacheProbe: (ref) => codexCacheProbe(source, ref),
  };
}

// ── The prompt-cache probe ───────────────────────────────────────────────────
//
// Ported from herdr-cache-alert `src/harness/codex.ts:259-326`. THREE facts live on THREE DIFFERENT
// ROWS, which is why this walks back collecting rather than matching one line:
//
//   the clock      — any row's own `timestamp`
//   the cache counts — `payload.info.last_token_usage` where `payload.type === "token_count"`
//   the turn + model — `payload.turn_id` / `payload.model` where `type === "turn_context"`
//
// `last_token_usage` is the TURN. `total_token_usage` is a running total that reaches millions and
// would read as permanently warm, so it is never read. And `turn_context` is written once per turn
// while `token_count` fires many times, so the model can sit much further back than the newest counts
// — which is why the window is 128 KB and not smaller: a shorter tail finds the tokens and loses the
// model, silently demoting every GPT-5.6 session to the five-minute rule.
//
// Codex publishes nothing that names its TTL outright, so unlike Claude there is no `observedTtl`
// here. The model is what the rule is picked by (`bridge/cache/rules/index.ts` § modelRuleFor).
//
// THE CONTEXT (.adr/0115, amended 2026-10-25) comes off the same `token_count` row, and it is the one
// harness whose log names both halves: `last_token_usage.input_tokens` is what the request carried,
// and `info.model_context_window` is the window. `input_tokens` already INCLUDES
// `cached_input_tokens` and `cache_write_input_tokens` (OpenAI's usage shape; on 0.164.0 a row reads
// 16209 input, 15770 cached, 436 written), so neither is added. Codex's own status line counts
// `total_tokens - reasoning_output_tokens`, the reply included, against the window less a 12k
// baseline; Collie counts what went in against the whole window, as it does for Claude. A `compacted`
// row after the counts means the next request carries less, so the probe names no context then.

async function codexCacheProbe(
  source: CodexTranscriptSource,
  ref: AgentSessionRef,
): Promise<CacheProbe | null> {
  const tail = await probeTail(source, ref);
  if (tail === null) return null;

  let lastRequestAt = 0;
  let stamp = "";
  let turnId = "";
  let model: string | undefined;
  let effort: string | undefined;
  let usage: JsonObject | undefined;
  let contextWindow: number | undefined;
  // A compaction met on the walk back before the counts is NEWER than them.
  let compactedAfter = false;

  walkBack(tail.lines, (raw): true | undefined => {
    const entry = asRecord(raw);
    if (entry === null) return undefined;
    if (lastRequestAt === 0) {
      const ts = asText(entry.timestamp);
      const at = Date.parse(ts ?? "");
      if (!Number.isNaN(at)) {
        lastRequestAt = at;
        stamp = ts ?? "";
      }
    }
    if (usage === undefined && entry.type === "compacted") compactedAfter = true;
    const payload = asRecord(entry.payload);
    if (usage === undefined && payload !== null && payload.type === "token_count") {
      const info = asRecord(payload.info);
      usage = asRecord(info?.last_token_usage) ?? undefined;
      if (usage !== undefined) contextWindow = asWindow(info?.model_context_window);
    }
    if (turnId === "" && entry.type === "turn_context" && payload !== null) {
      turnId = asText(payload.turn_id) ?? "";
      model = asText(payload.model);
      // The reasoning effort rides on the same row as the model, so the two always name one turn.
      effort = asText(payload.effort);
    }
    // `true` stops the walk; `undefined` keeps it going. Everything needed is in hand.
    return lastRequestAt !== 0 && usage !== undefined && turnId !== "" ? true : undefined;
  });

  if (lastRequestAt === 0) return null;
  const cacheReadTokens = tokenCount(usage?.cached_input_tokens);
  const cacheCreationTokens = tokenCount(usage?.cache_write_input_tokens);
  const detail = usage === undefined ? "no token_count in tail" : `cache read ${String(cacheReadTokens ?? "?")}`;
  const probe: CacheProbe = {
    lastRequestAt,
    // The turn id keeps a cold turn judged once. Falling back to the timestamp is correct but coarser:
    // `token_count` fires many times per turn, so a timestamp key re-judges the same turn every poll.
    turnId: turnId === "" ? String(lastRequestAt) : turnId,
    measuredAt: tail.mtimeMs,
    evidence: `${tail.path} (${stamp}${model === undefined ? "" : `, ${model}`}, ${detail})`,
  };
  if (cacheReadTokens !== undefined) probe.cacheReadTokens = cacheReadTokens;
  if (cacheCreationTokens !== undefined) probe.cacheCreationTokens = cacheCreationTokens;
  if (model !== undefined) probe.model = model;
  if (effort !== undefined) probe.effort = effort;
  const contextTokens = compactedAfter ? undefined : tokenCount(usage?.input_tokens);
  if (contextTokens !== undefined && contextTokens > 0) probe.contextTokens = contextTokens;
  if (contextWindow !== undefined) probe.contextWindow = contextWindow;
  return probe;
}
