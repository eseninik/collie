import { readFileSync } from "node:fs";
import { join } from "node:path";

// The transcript text in this fixture is masked in place. Every row keeps its
// column widths, punctuation and SGR escapes. The input and status chrome is intact.
const captureNames = ["screen-1.txt", "screen-ansi-1.txt", "screen-queued.txt", "screen-queued-ansi.txt", "try.txt"] as const;
type StoredCapture = (typeof captureNames)[number];
type Capture = StoredCapture | "screen-ansi-2.txt" | "screen-ansi-3.txt";
const rawDirectory = process.env.COLLIE_CLAUDE_CAPTURE_DIR;

// The three ANSI reads contain the same bytes. Keep all names in a raw replay.
export const claudeCaptureNames: readonly Capture[] = rawDirectory === undefined
  ? captureNames
  : [...captureNames, "screen-ansi-2.txt", "screen-ansi-3.txt"];
export const replayingRawClaudeCaptures = rawDirectory !== undefined;

// SAFETY: The committed fixture has one array of row strings for each stored capture name.
const maskedRows = JSON.parse(readFileSync(join(import.meta.dirname, "claude-21332-captures.json"), "utf8")) as Record<StoredCapture, string[]>;

export function readClaudeCapture(name: Capture): string {
  if (rawDirectory !== undefined) return readFileSync(join(rawDirectory, name), "utf8");
  const stored = name === "screen-ansi-2.txt" || name === "screen-ansi-3.txt" ? "screen-ansi-1.txt" : name;
  return maskedRows[stored].join("\n");
}

// The captures have an empty editor. Later reads model typing by changing only
// its input row, without rebuilding the frame, transcript or status footer.
// eslint-disable-next-line no-control-regex -- The captured prompt can contain ANSI escape codes.
const PROMPT = /^(?<prefix>(?:\u001b\[[\d;]*m)*❯(?:\u00a0(?:\u001b\[[\d;]*m)*)?)(?:\u001b\[2mPress up to edit queued messages\u001b\[0m)?$/u;

export function withClaudeDraft(capture: string, draft: string): string {
  const lineEnd = capture.includes("\r\n") ? "\r\n" : "\n";
  const rows = capture.split(lineEnd);
  const promptRow = rows.findLastIndex((row) => PROMPT.test(row));
  if (promptRow < 0) throw new Error("Claude capture has no empty prompt row");
  rows[promptRow] = rows[promptRow]!.replace(PROMPT, (_row, prefix: string) => (prefix === "❯" ? "❯ " : prefix) + draft);
  return rows.join(lineEnd);
}
