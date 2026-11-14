import { describe, expect, it } from "vitest";

import { fixtureRows, rowsOf, SURFACE_FIXTURES_DIR } from "../../test/surface-corpus";
import { lineText } from "../blocks";
import { foldSurface } from "../surface/fold";
import { findInputFrame } from "../surface/frame";
import { requireProfile } from "../surface/profile";
import { isFree } from "../surface/surface";
import { codexAdapter } from "./codex";

const captures = [
  ["codex-send-wrapped-running.ansi", "running", [
    "  GPT-6.1-Sol high · weekly 29% left · Context 53% left · /tmp/public-codex-workspace/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "  continued-workspace/project/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx · Main [default]",
  ]],
  ["codex-send-main-idle.ansi", "idle", [
    "  GPT-6.1-Sol high · weekly 29% left · Context 95% left · ~/projects/public-codex/xxxxxxxxxxxxxxxxx · Main [default]",
  ]],
] as const;
const profile = requireProfile("codex").idle;

describe("@oracle:requirement @req:SEND_1 captured Codex composer with Main status and warning footer", () => {
  for (const [name, turn, status] of captures) {
    for (const transport of ["ANSI", "plain"] as const) {
      const capture = fixtureRows(name, SURFACE_FIXTURES_DIR);
      const rows = transport === "ANSI" ? capture : rowsOf(capture.map(lineText).join("\n"));
      it(`${name} over ${transport}: the adapter reads a ready empty composer and only status rows as status`, () => {
        expect(codexAdapter.composerReady!(rows)).toBe(true);
        expect(codexAdapter.extractInputDraft(rows)).toBeNull();
        expect(codexAdapter.extractStatusLines(rows).map(lineText)).toEqual(status);
      });

      it(`${name} over ${transport}: the frame and named Codex pane agree on the empty composer and turn`, () => {
        expect(findInputFrame(rows, profile)).not.toBeNull();
        const read = foldSurface([{ seq: 1, source: "screen", at: 0, revision: 1, rows, ask: null }], { idle: profile, pollMs: 1000 });
        expect(read.frame).not.toBeNull();
        expect(read.surface).toMatchObject({ turn, modal: "none", composer: "empty" });
        expect(isFree(read.surface)).toBe(turn === "idle");
      });
    }
  }
});

describe("@oracle:requirement @req:SEND_3 real Codex dialogs still own the keyboard", () => {
  it.each([
    "codex--v0169-model-dialog--w120.txt",
    "codex--v0156-approval-exec-2opt.txt",
    "codex--v0156-approval-patch.txt",
  ])("%s offers no ready/free composer", (name) => {
    const rows = fixtureRows(name);
    expect(codexAdapter.composerReady!(rows)).toBe(false);
    const read = foldSurface([{ seq: 1, source: "screen", at: 0, revision: 1, rows, ask: null }], { idle: profile, pollMs: 1000 });
    expect(isFree(read.surface)).toBe(false);
    expect(read.surface.modal).not.toBe("none");
  });
});
