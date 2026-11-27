import { describe, expect, test } from "bun:test";
import { claude21332, claudeFrames, type ClaudeFrame } from "../../web/src/test/claude-21332.ts";
import { claudeCaptureNames, readClaudeCapture, replayingRawClaudeCaptures, withClaudeDraft } from "../../web/src/test/claude-21332-captures.ts";
import { FakePane, fixture, rig, useScratchDir } from "./protocol.rig.ts";

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

  constructor(public capture: string) {
    super("claude");
  }

  override render(): string {
    if (this.box !== "") return withClaudeDraft(this.capture, this.box);
    const queued = this.over[0];
    if (queued === undefined) return this.capture;

    // After Enter, Claude draws the queue above the spinner. The viewport scrolls
    // by the new rows.
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

const PLAIN_CAPTURE = "screen-1.txt";
const ANSI_CAPTURE = "screen-ansi-1.txt";
const ANSI_QUEUED_CAPTURE = "try.txt";
const QUEUED_PLAIN = "screen-queued.txt";
const QUEUED_ANSI = "screen-queued-ansi.txt";
const LIVE_SEND_WORDS = "Please check the sample output.";

function replaceCaptureText(capture: string, before: string, after: string): string {
  const offset = capture.lastIndexOf(before);
  if (offset < 0) throw new Error("Claude capture is missing the row to change");
  return capture.slice(0, offset) + after + capture.slice(offset + before.length);
}

function insertToolRow(capture: string): string {
  const lineEnd = "\r\n";
  const tool = readClaudeCapture("screen-queued-ansi.txt").split(lineEnd).findLast((row) => row.includes("●") && row.includes("("));
  const rows = capture.split(lineEnd);
  const spinner = rows.findLastIndex((row) => row.includes("Bloviating…"));
  if (tool === undefined || spinner < 1) throw new Error("Claude capture is missing a tool or spinner row");
  rows.splice(spinner, 0, tool);
  return rows.slice(1).join(lineEnd);
}

function liveCapture(capture: string, next: string): CapturedClaude332Pane {
  const pane = new CapturedClaude332Pane(capture);
  pane.afterInput = () => {
    // Show the change on the first read of the typed line and keep it on subsequent reads.
    if (pane.box === LIVE_SEND_WORDS) pane.capture = next;
  };
  return pane;
}

const rowChanges = [
  ["spinner timer (plain)", PLAIN_CAPTURE, "14m 50s", "14m 51s"],
  ["spinner timer (ANSI)", ANSI_CAPTURE, "15m 6s", "15m 7s"],
  ["Running timer (plain)", PLAIN_CAPTURE, "Running… (1m 46s)", "Running… (1m 47s)"],
  ["Running timer (ANSI)", ANSI_QUEUED_CAPTURE, "Running… (1m 54s)", "Running… (1m 55s)"],
  ["HUD context percentage (plain)", PLAIN_CAPTURE, "36% | git:", "37% | git:"],
  ["HUD weekly percentage (ANSI)", ANSI_CAPTURE, "42%\u001b[0m", "43%\u001b[0m"],
  ["auto-compact next (plain)", PLAIN_CAPTURE, "1% until auto-compact", "    auto-compact next"],
  ["auto-compact next (ANSI)", ANSI_CAPTURE, "1% until auto-compact", "    auto-compact next"],
  ["shell count (plain)", PLAIN_CAPTURE, "· 1 shell ·", "· 2 shells ·"],
  ["shell count (ANSI)", ANSI_QUEUED_CAPTURE, "1 shell\u001b[0m", "2 shells\u001b[0m"],
  ["Tip (plain)", PLAIN_CAPTURE, "Tip: Use /btw to ask a side question without interrupting Claude", "Tip: Use a fresh session for a new topic"],
  ["Tip (ANSI)", ANSI_CAPTURE, "Tip: Use /btw to ask a side question without interrupting Claude", "Tip: Use a fresh session for a new topic"],
  ["Running in the background (plain)", PLAIN_CAPTURE, "Running… (1m 46s)", "Running in the background (↓ to manage)"],
  ["Running in the background (ANSI)", ANSI_QUEUED_CAPTURE, "Running… (1m 54s)", "Running in the background (↓ to manage)"],
  ["queued viewport spinner timer (plain)", QUEUED_PLAIN, "17m 18s", "17m 19s"],
  ["queued viewport shell count (ANSI)", QUEUED_ANSI, "1 shell\u001b[0m", "2 shells\u001b[0m"],
  ["queued viewport Tip disappears (plain)", QUEUED_PLAIN, "  ⎿ \u00a0Tip: Use /btw to ask a side question without interrupting Claude", ""],
  ["queued viewport Tip disappears (ANSI)", QUEUED_ANSI, "  ⎿ \u00a0Tip: Use /btw to ask a side question without interrupting Claude", ""],
  ["queued viewport auto-compact returns to a percentage (ANSI)", QUEUED_ANSI, "    auto-compact next", "1% until auto-compact"],
] as const;

describe("@req:REQ-ENTER-REDRAW @oracle:requirement direct Claude send while the captured viewport updates", () => {
  async function expectOneEnter(name: string, capture: string, next: string) {
    const pane = liveCapture(capture, next);
    const { send } = rig({ pane, version: "2.1.332", block: true });
    const { receipt } = await send(LIVE_SEND_WORDS, { fromPhone: true });
    const enters = pane.keysSeen.filter((key) => key === "Enter");
    console.info(name, JSON.stringify({ outcome: receipt?.outcome, reason: receipt?.reason ?? null, enters: enters.length }));
    expect(receipt?.outcome).toBe("sent");
    expect(enters).toEqual(["Enter"]);
    expect(pane.over[0]).toBe("❯ " + LIVE_SEND_WORDS);
    expect(pane.box).toBe("");
  }

  test.each([...rowChanges])("sends with one Enter after a change in %s", async (name, source, before, after) => {
    const capture = readClaudeCapture(source);
    await expectOneEnter(name, capture, replaceCaptureText(capture, before, after));
  });

  test("sends with one Enter when a tool row appears above the box (ANSI)", async () => {
    const capture = readClaudeCapture(ANSI_CAPTURE);
    await expectOneEnter("new tool row (ANSI)", capture, insertToolRow(capture));
  });
});

test("@req:REQ-ENTER-DIALOG @oracle:requirement withholds Enter when Claude draws a permission dialog at the box", async () => {
  const capture = readClaudeCapture(ANSI_CAPTURE);
  const rows = capture.split("\r\n");
  const footer = rows.findLastIndex((row) => row.includes("until auto-compact"));
  const permission = fixture("claude--v2303-permission-bash-bg-agent-rm--w160.txt").split(/\r?\n/u);
  const question = permission.findIndex((row) => row.includes("Do you want to proceed?"));
  if (footer < 0 || question < 0) throw new Error("Claude capture is missing the footer or permission dialog");
  const next = [...rows.slice(0, footer), ...permission.slice(question)].join("\r\n");
  const pane = liveCapture(capture, next);
  const { send } = rig({ pane, version: "2.1.332", block: true });
  const { receipt } = await send(LIVE_SEND_WORDS, { fromPhone: true });
  const enters = pane.keysSeen.filter((key) => key === "Enter");
  console.info("permission dialog", JSON.stringify({ outcome: receipt?.outcome, reason: receipt?.reason ?? null, enters: enters.length }));
  expect(receipt?.outcome).toBe("typed_not_submitted");
  expect(enters).toEqual([]);
  expect(pane.box).toBe(LIVE_SEND_WORDS);
});
