import { describe, expect, it } from "vitest";
import { claude21332, claudeFrames } from "../../test/claude-21332";
import { claudeCaptureNames, readClaudeCapture, replayingRawClaudeCaptures, withClaudeDraft } from "../../test/claude-21332-captures";
import { idleFor, readScreen, rowsOf } from "../../test/surface-corpus";
import { wholeDraft } from "./frame";

function read(text: string) {
  return readScreen(rowsOf(text), "claude", idleFor("claude"));
}

function expectOpenBox(text: string, turn: "running" | "idle") {
  const result = read(text);
  expect(result.surface).toMatchObject({ turn, modal: "none", composer: "empty" });
  expect(result.frame).not.toBeNull();
  expect(wholeDraft(result.frame!)).toBe("");
}

describe("@req:REQ-SCREEN @oracle:requirement Claude Code 2.1.332 normal working screens", () => {
  it.each(claudeFrames)("reads the captured %s with the two-line status footer", (frame) => {
    expectOpenBox(claude21332(frame), "running");
  });

  it("reads the queued message and its editing hint without the Bash rows or the custom status line", () => {
    expectOpenBox(claude21332("queued message", { bash: false, hud: false }), "running");
  });

  it("reads the Bash running rows without the queued message or the custom status line", () => {
    expectOpenBox(claude21332("running Bash", { hud: false }), "running");
  });

  // screen-queued.txt and screen-queued-ansi.txt show this tail above the mode row.
  it("reads the running turn with an empty box and the right-aligned auto-compact next tail", () => {
    expectOpenBox(claude21332("running Bash", { compact: "next" }), "running");
  });

  it("reads the idle box above the two-line custom status without auto-compact", () => {
    expectOpenBox(claude21332("running Bash", { bash: false, running: false, compact: false }), "idle");
  });

  it("reads the idle box above the two-line custom status with the right-aligned auto-compact tail", () => {
    expectOpenBox(claude21332("running Bash", { bash: false, running: false }), "idle");
  });
});

// Oracle: the saved screen shows a working turn and the normal input box.
describe("@req:REQ-REAL-READ @oracle:requirement Claude Code 2.1.332 saved viewport", () => {
  it.each(claudeCaptureNames)("reads the original viewport and the draft on %s", (name) => {
    const text = readClaudeCapture(name);
    const draft = "Please check the sample output.";
    const before = read(text);
    const after = read(withClaudeDraft(text, draft));
    if (replayingRawClaudeCaptures) {
      const describeRead = ({ surface, frame, cues }: ReturnType<typeof read>) => ({
        turn: surface.turn,
        modal: surface.modal,
        composer: surface.composer,
        frame: frame === null ? null : [frame.top, frame.bottom],
        cueStrength: cues?.strength ?? null,
        cues: cues?.cues.map((cue) => [cue.kind, cue.row]) ?? [],
      });
      console.info(name, JSON.stringify({ before: describeRead(before), after: describeRead(after) }));
    }
    expect(before.surface).toMatchObject({ turn: "running", modal: "none", composer: "empty" });
    expect(before.frame).not.toBeNull();
    expect(wholeDraft(before.frame!)).toBe("");
    expect(after.surface).toMatchObject({ turn: "running", modal: "none", composer: "draft" });
    expect(after.frame).not.toBeNull();
    expect(wholeDraft(after.frame!)).toBe(draft);
  });
});
