import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines } from "../../blocks";
import { claudeAdapter } from "./index";

// Oracle: owner item 9 and the conformance contract: a visible modal owns the keyboard.
// An unrecognized row outside its complete footer must not make ordinary message typing available.
// The independent test author has not read production implementation or the builder's diff.
const FIXTURE = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes", "claude--v2327-effort-dialog.txt");
const FOOTER = "  ←/→ to adjust · s to use this session only · Enter to save · Esc to cancel";

describe("@req:FIX-EFFORT-UNKNOWN-TAIL @oracle:requirement an unknown row after the Effort footer", () => {
  it("keeps the composer unavailable while the complete modal remains above its empty frame", () => {
    const raw = readFileSync(FIXTURE, "utf8");
    const original = splitLines(parseAnsi(raw));
    expect(claudeAdapter.composerReady?.(original)).toBe(false);

    const rows = raw.split("\n");
    const footer = rows.indexOf(FOOTER);
    expect(footer, "the captured Effort footer is intact").toBeGreaterThanOrEqual(0);
    rows.splice(footer + 1, 0, "  Additional status: waiting for refresh.");
    const changed = splitLines(parseAnsi(rows.join("\n")));
    const blocks = claudeAdapter.buildBlocks(changed);

    // Detection may decline this modified screen. Keyboard ownership must still fail closed.
    expect(claudeAdapter.composerReady?.(changed), `rendered block kinds: ${blocks.map((block) => block.kind).join(", ")}`).toBe(false);
  });
});
