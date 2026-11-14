import { describe, expect, it } from "vitest";

import { fixtureRows, readScreen } from "../../test/surface-corpus";
import { requireProfile } from "./profile";
import { isFree } from "./surface";

// Owner's screen brief A1: these are real 0.169 captures, taken in a disposable terminal.
// Their keyboard state is fixed by the capture action, independently of the reader's result.
describe("@oracle:requirement @req:A1 Codex 0.169 screen state", () => {
  const profile = requireProfile("codex").idle;
  it.each([
    ["codex--v0169-idle--w120.txt", "idle"],
    ["codex--v0169-idle-tip--w80.txt", "idle"],
    ["codex--v0169-idle-after-turn--w120.txt", "idle"],
    ["codex--v0169-working--w120.txt", "running"],
    ["codex--v0169-working-queued--w120.txt", "running"],
    ["codex--v0169-working-queued--w80.txt", "running"],
  ] as const)("%s is a conversation with an empty composer", (name, turn) => {
    const read = readScreen(fixtureRows(name), "codex", profile);
    expect(read.surface).toMatchObject({ turn, modal: "none", composer: "empty" });
    expect(read.frame, "the captured status line and its wrapped tail still frame the composer").not.toBeNull();
  });

  it("a real Codex 0.169 dialog still owns the keyboard", () => {
    const read = readScreen(fixtureRows("codex--v0169-model-dialog--w120.txt"), "codex", profile);
    expect(read.surface.modal).not.toBe("none");
    expect(isFree(read.surface)).toBe(false);
  });
});
