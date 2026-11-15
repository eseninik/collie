import { describe, expect, it } from "vitest";

import { fixtureRows, rowsOf, SURFACE_FIXTURES_DIR } from "../../test/surface-corpus";
import { lineText } from "../blocks";
import { foldSurface } from "../surface/fold";
import { findInputFrame } from "../surface/frame";
import { requireProfile } from "../surface/profile";
import { codexAdapter } from "./codex";

// A narrow pane (the owner's phone, 2026-11-15): Codex 0.169 wraps its status line over three or four
// rows, each continuation indented two columns, and the footer hints take rows of their own. The capture
// is the 120-column one rewrapped the way Codex wraps it; review finding of the codex-send fix.
const profile = requireProfile("codex").idle;
const STATUS = "GPT-6.1-Sol high · weekly 29% left · Context 53% left · /tmp/public-codex-workspace/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/continued-workspace/project/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx · Main [default]";

/** Words onto rows of `width` columns, two columns of indent on every row, as Codex draws its status. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let row = "";
  for (const word of text.split(" ")) {
    const next = row === "" ? word : `${row} ${word}`;
    if (2 + next.length <= width) row = next;
    else {
      if (row !== "") out.push(`  ${row}`);
      let rest = word;
      while (2 + rest.length > width) {
        out.push(`  ${rest.slice(0, width - 2)}`);
        rest = rest.slice(width - 2);
      }
      row = rest;
    }
  }
  if (row !== "") out.push(`  ${row}`);
  return out;
}

function narrow(width: number, footer: readonly string[]) {
  const plain = fixtureRows("codex-send-wrapped-running.ansi", SURFACE_FIXTURES_DIR).map(lineText);
  const prompt = plain.findIndex((row) => row.startsWith("› "));
  const status = wrap(STATUS, width);
  return { rows: rowsOf([...plain.slice(0, prompt + 2), ...status, ...footer].join("\n")), status };
}

describe("a narrow Codex pane: the wrapped status is one edge and the box is ready", () => {
  for (const width of [60, 45]) {
    for (const [label, footer] of [
      ["with both hints", ["  ← for agents · ? for shortcuts", "  ⚠ 1 warning · f2 to view"]],
      ["with no hint", []],
    ] as const) {
      it(`${String(width)} columns, ${label}`, () => {
        const { rows, status } = narrow(width, footer);
        expect(status.length).toBeGreaterThanOrEqual(3);
        expect(findInputFrame(rows, profile)).not.toBeNull();
        expect(codexAdapter.composerReady!(rows)).toBe(true);
        expect(codexAdapter.extractInputDraft(rows)).toBeNull();
        expect(codexAdapter.extractStatusLines(rows).map(lineText)).toEqual(status);
        const read = foldSurface([{ seq: 1, source: "screen", at: 0, revision: 1, rows, ask: null }], { idle: profile, pollMs: 1000 });
        expect(read.surface).toMatchObject({ modal: "none", composer: "empty" });
      });
    }
  }
});

// Real Codex 0.169 at 45 and 60 columns (tmux probe, 2026-11-15): the status is cut to one row with
// `…` rather than wrapped, and at 45 columns the hint row drops `? for shortcuts`.
describe("real narrow Codex 0.169 captures: the box is ready and only the status row is status", () => {
  for (const width of [45, 60]) {
    for (const transport of ["ANSI", "plain"] as const) {
      it(`${String(width)} columns over ${transport}`, () => {
        const capture = fixtureRows(`codex-v0169-idle-narrow-w${String(width)}.ansi`, SURFACE_FIXTURES_DIR);
        const rows = transport === "ANSI" ? capture : rowsOf(capture.map(lineText).join("\n"));
        expect(findInputFrame(rows, profile)).not.toBeNull();
        expect(codexAdapter.composerReady!(rows)).toBe(true);
        expect(codexAdapter.extractInputDraft(rows)).toBeNull();
        expect(codexAdapter.extractStatusLines(rows).map(lineText)).toEqual([expect.stringMatching(/^ {2}GPT-6\.1-Sol high · .*…$/u)]);
        const read = foldSurface([{ seq: 1, source: "screen", at: 0, revision: 1, rows, ask: null }], { idle: profile, pollMs: 1000 });
        expect(read.surface).toMatchObject({ modal: "none", composer: "empty" });
      });
    }
  }
});
