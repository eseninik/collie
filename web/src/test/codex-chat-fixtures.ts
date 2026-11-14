import { readFileSync } from "node:fs";

import { parseCodexTranscript } from "../../../bridge/journal/codex";
import { parseClaudeTranscript } from "../../../bridge/journal/claude";
import type { TranscriptEntry } from "@/lib/types";

// Node-side test helper only: the browser receives the resulting shared wire entries through its API stub.
export function chatComparisonEntries(harness: "claude" | "codex"): TranscriptEntry[] {
  const source = readFileSync(new URL(`../../../bridge/journal/fixtures/codex-chat/${harness}-reference.jsonl`, import.meta.url), "utf8");
  return harness === "codex" ? parseCodexTranscript(source) : parseClaudeTranscript(source);
}
