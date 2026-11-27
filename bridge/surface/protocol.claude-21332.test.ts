import { describe, expect, test } from "bun:test";
import { claude21332, claudeFrames, type ClaudeFrame } from "../../web/src/test/claude-21332.ts";
import { claudeCaptureNames, readClaudeCapture, replayingRawClaudeCaptures, withClaudeDraft } from "../../web/src/test/claude-21332-captures.ts";
import { FakePane, rig, useScratchDir } from "./protocol.rig.ts";

useScratchDir();

class Claude332Pane extends FakePane {
  override drawsQueuedRow = true;

  constructor(private readonly frame: ClaudeFrame) {
    super("claude");
  }

  override render(): string {
    // The rig records what Enter put in the queue. Draw it in this Claude version's format.
    return claude21332(this.frame, { box: this.box, newlyQueued: this.over[0]?.slice("❯ ".length) });
  }
}

describe("@req:REQ-DIRECT @oracle:requirement phone sends on captured Claude Code 2.1.332 screens", () => {
  test.each([...claudeFrames])("sends directly and queues exactly once on %s", async (frame) => {
    const pane = new Claude332Pane(frame);
    const { send } = rig({ pane, version: "2.1.332" });
    const words = "Please check the sample output.";
    const answer = await send(words, { fromPhone: true });

    expect(answer.receipt).toMatchObject({ outcome: "sent", profileId: "claude", profileStatus: "provisional", queued: true });
    expect(answer.offers).toEqual([]);
    expect(pane.keysSeen.filter((key) => key === "Enter")).toEqual(["Enter"]);
    expect(pane.over[0]).toBe("❯ " + words);
    expect(pane.box).toBe("");
  });
});

class CapturedClaude332Pane extends FakePane {
  override drawsQueuedRow = true;

  constructor(private readonly capture: string) {
    super("claude");
  }

  override render(): string {
    if (this.box !== "") return withClaudeDraft(this.capture, this.box);
    const queued = this.over[0];
    if (queued === undefined) return this.capture;

    // After Enter, Claude draws the queue above the spinner. The viewport scrolls
    // by the new rows. Before Enter, the capture changes only in the input row.
    const lineEnd = this.capture.includes("\r\n") ? "\r\n" : "\n";
    const rows = this.capture.split(lineEnd);
    const spinner = rows.findLastIndex((row) => /[✢✻✽]/u.test(row));
    if (spinner < 0) throw new Error("Claude capture has no running spinner");
    const hint = "  ⎿  Queued · ctrl+q to send now";
    const added = this.capture.includes("\u001b[")
      ? [`\u001b[38;2;153;153;153m\u001b[48;2;55;55;55m${queued.padEnd(157)}\u001b[0m`, `\u001b[38;2;153;153;153m${hint}\u001b[0m`, ""]
      : [queued, hint, ""];
    rows.splice(spinner, 0, ...added);
    return rows.slice(added.length).join(lineEnd);
  }
}

// Oracle: a normal Claude working screen accepts a direct phone send with one Enter.
describe("@req:REQ-REAL-SEND @oracle:requirement phone send on the Claude Code 2.1.332 saved viewport", () => {
  test.each([...claudeCaptureNames])("queues exactly once on %s", async (name) => {
    const pane = new CapturedClaude332Pane(readClaudeCapture(name));
    const { send } = rig({ pane, version: "2.1.332", block: true });
    const words = "Please check the sample output.";
    const answer = await send(words, { fromPhone: true });
    if (replayingRawClaudeCaptures) {
      const { receipt, surface } = answer;
      console.info(name, JSON.stringify({ outcome: receipt?.outcome, reason: receipt?.reason, keys: pane.keysSeen, s0: receipt?.s0, s1: receipt?.s1, s2: receipt?.s2, turn: surface?.turn, modal: surface?.modal, composer: surface?.composer }));
    }

    expect(answer.receipt).toMatchObject({ outcome: "sent", profileId: "claude", profileStatus: "provisional", queued: true });
    expect(answer.offers).toEqual([]);
    expect(pane.keysSeen.filter((key) => key === "Enter")).toEqual(["Enter"]);
    expect(pane.over[0]).toBe("❯ " + words);
    expect(pane.box).toBe("");
  });
});
