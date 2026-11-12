// A held phone send goes into a running turn (owner's case, 2026-11-12).
//
// On a Claude Code pane (2.1.322) a person's send from the phone during a running turn was held
// (`held`, cause `turn_running`, no key typed at all), and it went out only about five minutes later,
// when the turn ended. Claude Code takes text while a turn runs (Enter queues it), and the Send
// Protocol's queued path supports that, but `tickHolds` released a held request only once the pane
// read idle. The owner's requirement, verbatim: «мне надо чтобы всегда при отправке сообщение
// отправлялось в терминал».
//
// The rule under test (INTURN-1..7): a person's phone send (`fromPhone`, mode `send`, plain text)
// held on a pane whose harness takes messages in a turn goes out into the running turn once
// FREE_POLLS (2) polls in a row read the turn running, no modal and an empty box; its run takes the
// queued path (the text, then the submit key). Everything else keeps today's rules: a caller that is
// not the phone, a command, a harness that takes nothing in a turn, and a marked send held over a
// draft wait for the turn to end. An in-turn release that meets a box not free at its own S0 presses
// nothing, goes back to its place and spends none of the hold's tries (HOLD_TRIES = 5).
//
// Decisions after the blind review (INTURN-8..10): such a hold is released into a turn at most
// IN_TURN_RELEASES (8) times; a phone send goes into the turn ahead of a queue head that may not
// (the owner's words outrank the queue order); and the mark survives a bridge restart, while a held
// file written before the mark existed waits for the turn to end.
//
// The hold is made the way a real pane makes one in a turn: Claude's permission dialog stands in the
// box's place at S0 (`not_free`), then the person answers it and the turn runs on over an empty box.
// The fake pane draws Claude Code's turn as the captures show it (claude--v2-1-310-queued-over-spinner):
// the spinner row over the rule, the `❯` box, the rule, the mode row. The polls read the pane through
// the Claude profile, as the bridge's Surface does.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { loadProfiles, profileFor, resetProfileLog, type Profile, type ProfileForOptions } from "../../web/src/lib/surface/profile.ts";
import type { SendAnswer } from "../../web/src/lib/surface/send.ts";
import type { Surface } from "../../web/src/lib/surface/surface.ts";
import { surfaceOfScreen } from "../../web/src/lib/surface/fold.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import { asJsonObject } from "../../web/src/lib/json.ts";
import { HoldStore } from "./holds.ts";
import { KeyGate } from "./key-gate.ts";
import { RowRing, SendProtocol, SessionLocks, type SendRequest } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

const RULE = `\u001b[38;2;136;136;136m${"─".repeat(60)}\u001b[0m`;
/** Claude Code's spinner row while a turn runs (the shape of claude--v2-1-310-queued-over-spinner). */
const SPINNER = "✻ Wibbling… (4s · ↓ 304 tokens)";
/** Claude Code's permission dialog, drawn in the box's place. */
const PERMISSION = [
  "────────────────────────────────────────────────────────────",
  " Bash command",
  "",
  "   npm test",
  "   Run the parser tests",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and don't ask again for npm test commands",
  "   3. No",
  "",
  " Esc to cancel · Tab to amend",
];

/** A Claude Code pane: a transcript, the spinner while a turn runs, the box, and the dialog in its place. */
class ClaudePane {
  transcript = ["> fix the failing test in the parser", "● Reading parser.ts and the test file."];
  box = "";
  /** The turn runs while this is set: the spinner row stands over the box. */
  running = false;
  /** A dialog in the box's place: keys go nowhere the box can see. */
  dialog: string[] | null = null;
  /** Texts Enter queued during a turn: drawn as Claude's queued rows over the spinner. */
  queued: string[] = [];
  /** Submit keys the box ignores before it takes one again: the text stays in the box. */
  ignoreEnter = 0;
  calls: string[] = [];
  keysSeen: string[] = [];
  revision = 1;
  reads = 0;

  render(): string {
    const rows = [...this.transcript, ""];
    if (this.dialog !== null) return [...rows, ...this.dialog].join("\n");
    for (const text of this.queued) rows.push(`❯ ${text}`, "  ctrl+enter to send now", "");
    if (this.running) rows.push(SPINNER, "");
    rows.push(RULE, this.box === "" ? "❯" : `❯ ${this.box}`, RULE, this.running ? "  ⏸ manual mode on · esc to interrupt" : "  ⏸ manual mode on");
    return rows.join("\n");
  }

  readGrid = (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    this.reads++;
    return Promise.resolve(muxOk({ paneId, text: this.render(), truncated: false, revision: this.revision }));
  };

  typeText = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    this.calls.push(`type:${text}`);
    if (this.dialog === null) {
      this.box += text;
      this.revision++;
    }
    return Promise.resolve(muxAck());
  };

  pasteText = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    this.calls.push(`paste:${text}`);
    if (this.dialog === null) {
      this.box += text;
      this.revision++;
    }
    return Promise.resolve(muxAck());
  };

  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
    for (const key of keys) {
      this.keysSeen.push(key);
      if (this.dialog !== null) continue;
      if (key === "Backspace") this.box = [...this.box].slice(0, -1).join("");
      else if (key === "Enter" && this.ignoreEnter > 0) this.ignoreEnter--;
      else if (key === "Enter" && this.box !== "") {
        if (this.running) this.queued.push(this.box);
        else this.transcript.push(`> ${this.box}`);
        this.box = "";
      }
      this.revision++;
    }
    return Promise.resolve(muxAck());
  };

  /** The person answers the dialog: the turn runs on over an empty box. */
  answerDialog(): void {
    this.dialog = null;
    this.revision++;
  }

  /** The turn ends: the spinner goes, Claude takes the queued texts as the next turn's input. */
  endTurn(): void {
    this.running = false;
    this.revision++;
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-inturn-"));
  resetProfileLog();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The owner's Claude Code version (2.1.322): newer than the profile's verified range, so provisional, still trusted with a turn. */
const OWNER_VERSION = "2.1.322";

/** A profile whose harness takes nothing in a turn: Enter steers it and no key queues. */
function takesNothingInTurn(profile: Profile): Profile {
  const { commandWhileRunning, queueKey, queueKeyByPlatform, ...keys } = profile.keys;
  void commandWhileRunning;
  void queueKey;
  void queueKeyByPlatform;
  return { ...profile, keys: { ...keys, enterWhileRunning: "steers" } };
}

let ids = 0;

function rig(options: { version?: string | null; edit?: (profile: Profile) => Profile; pane?: ClaudePane; clock?: { now: number } } = {}) {
  const pane = options.pane ?? new ClaudePane();
  const clock = options.clock ?? { now: 1_000_000 };
  const now = (): number => clock.now;
  const holds = new HoldStore(join(dir, "held"), now);
  const base = loadProfiles().get("claude")!;
  const profile = options.edit === undefined ? base : options.edit(base);
  const version = options.version === undefined ? OWNER_VERSION : options.version;
  const lookup: ProfileForOptions = { log: () => undefined, profiles: new Map([["claude", profile]]) };
  const protocol = new SendProtocol({
    mux: { readGrid: pane.readGrid, typeText: pane.typeText, pasteText: pane.pasteText },
    gate: new KeyGate(pane, now),
    store: new RequestStore(join(dir, "sends"), now),
    locks: new SessionLocks(),
    ring: new RowRing(),
    profile: () => Promise.resolve(profileFor("claude", version, lookup)),
    generation: () => "claude:gen-1",
    holds,
    now,
    sleep: (ms: number) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
  const send = (text: string, over: Partial<SendRequest> = {}): Promise<SendAnswer> =>
    protocol.handle({ id: `req-in-${String(++ids).padStart(6, "0")}`, text, mode: "send", ...over }, { session: "main", paneId: "%1", harness: "claude" });
  /** What the bridge's Surface reads on the pane now, through the Claude profile. */
  const read = (): Surface => surfaceOfScreen({ seq: 0, source: "screen", at: clock.now, revision: pane.revision, rows: splitLines(parseAnsi(pane.render())), ask: null }, profile.idle).surface;
  /** One poll, a second after the last: the Surface as read now, or the one given. */
  const tick = async (surface?: Surface): Promise<(SendAnswer | null)[]> => {
    clock.now += 1000;
    const seen = surface ?? read();
    return Promise.all(protocol.tickHolds("main", () => seen));
  };
  return { pane, clock, holds, protocol, send, read, tick };
}

type Rig = ReturnType<typeof rig>;

/** The hold the owner met: a phone send while the turn runs and Claude's permission dialog stands in the box's place. */
async function heldInTurn(r: Rig, text: string, over: Partial<SendRequest> = { fromPhone: true }): Promise<string> {
  r.pane.running = true;
  r.pane.dialog = PERMISSION;
  const id = `held-${String(++ids).padStart(6, "0")}`;
  const answer = await r.send(text, { id, ...over });
  expect(answer.receipt).toMatchObject({ requestId: id, outcome: "held", keys: [] });
  expect(r.pane.calls).toEqual([]);
  expect(r.pane.keysSeen).toEqual([]);
  return id;
}

/** Polls that read the turn running, no modal, an empty box: what the person sees after answering the dialog. */
const IN_TURN_FREE = { turn: "running", modal: "none", composer: "empty" } as const;
/** The same reading as a whole Surface, for a poll that reads it while the pane itself shows something else. */
const IN_TURN_FREE_SURFACE: Surface = { revision: 1, ...IN_TURN_FREE };

describe("the fake Claude pane reads as Claude Code does", () => {
  test("a turn over an empty box reads running, no modal, empty; the dialog reads not free; the ended turn reads free", () => {
    const r = rig();
    r.pane.running = true;
    expect(r.read()).toMatchObject(IN_TURN_FREE);
    r.pane.dialog = PERMISSION;
    expect(r.read().modal).not.toBe("none");
    r.pane.dialog = null;
    r.pane.running = false;
    expect(r.read()).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
  });

  test("a fresh phone send into the running turn takes the queued path (Collie's own send path supports it)", async () => {
    const r = rig();
    r.pane.running = true;
    const answer = await r.send("and add a test for it", { fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true });
    expect(answer.receipt?.keys.at(-1)).toBe("Enter");
    expect(r.pane.queued).toEqual(["and add a test for it"]);
  });
});

describe("INTURN: a held phone send goes into the running turn (owner, 2026-11-12)", () => {
  test("INTURN-1 a held phone send goes out while the turn still runs, on two in-turn free polls, by the queued path", async () => {
    const r = rig();
    const id = await heldInTurn(r, "also check the lint output");
    r.pane.answerDialog();
    expect(r.read()).toMatchObject(IN_TURN_FREE);
    // First in-turn free poll: it only counts. The row's cause reads the turn, as the owner saw it.
    expect(await r.tick()).toEqual([]);
    expect(r.holds.get(id)?.cause).toBe("turn_running");
    expect(r.pane.keysSeen).toEqual([]);
    // Second in-turn free poll: the release runs now, into the turn.
    const [released] = await r.tick();
    expect(released?.receipt).toMatchObject({ requestId: id, outcome: "sent", queued: true });
    expect(released?.receipt?.keys.at(-1)).toBe("Enter");
    expect(r.pane.keysSeen.filter((key) => /^esc(ape)?$/iu.test(key))).toEqual([]);
    // Claude queued it in the running turn; the turn never ended.
    expect(r.pane.running).toBe(true);
    expect(r.pane.queued).toEqual(["also check the lint output"]);
    expect(r.pane.box).toBe("");
    expect(r.holds.list()).toEqual([]);
  });

  test("INTURN-1 a phone send held behind it in the same turn goes too, in order, without the turn ending", async () => {
    const r = rig();
    const first = await heldInTurn(r, "first thought");
    const second = `held-${String(++ids).padStart(6, "0")}`;
    expect((await r.send("second thought", { id: second, fromPhone: true })).receipt).toMatchObject({ outcome: "held", keys: [] });
    r.pane.answerDialog();
    const sent: string[] = [];
    for (let i = 0; i < 8 && r.holds.list().length > 0; i++) {
      for (const answer of await r.tick()) if (answer?.receipt?.outcome === "sent") sent.push(answer.receipt.requestId);
    }
    expect(sent).toEqual([first, second]);
    expect(r.pane.running).toBe(true);
    expect(r.pane.queued).toEqual(["first thought", "second thought"]);
  });

  test("INTURN-2 one in-turn free poll is not enough, and a poll with something open at the box between them starts the count again", async () => {
    const r = rig();
    const id = await heldInTurn(r, "also check the lint output");
    r.pane.answerDialog();
    expect(await r.tick()).toEqual([]);
    // Another dialog shows on the next poll: the run of free polls resets.
    r.pane.dialog = PERMISSION;
    expect(await r.tick()).toEqual([]);
    r.pane.answerDialog();
    expect(await r.tick()).toEqual([]);
    expect(r.pane.keysSeen).toEqual([]);
    expect(r.pane.calls).toEqual([]);
    expect(r.holds.get(id)?.state).toBe("held");
    // The second in-turn free poll in a row releases it into the turn.
    const [released] = await r.tick();
    expect(released?.receipt).toMatchObject({ requestId: id, outcome: "sent", queued: true });
    expect(r.pane.running).toBe(true);
    expect(r.pane.queued).toEqual(["also check the lint output"]);
  });

  test("INTURN-3 a held send that is not a person's phone send (walky talky, CLI) waits for the turn to end", async () => {
    const r = rig();
    const id = await heldInTurn(r, "a message from walky talky", {});
    r.pane.answerDialog();
    for (let i = 0; i < 6; i++) expect(await r.tick()).toEqual([]);
    expect(r.pane.calls).toEqual([]);
    expect(r.pane.keysSeen).toEqual([]);
    expect(r.holds.get(id)?.state).toBe("held");
    r.pane.endTurn();
    expect(await r.tick()).toEqual([]);
    const [released] = await r.tick();
    expect(released?.receipt).toMatchObject({ requestId: id, outcome: "sent" });
    expect(released?.receipt?.queued).toBeUndefined();
    expect(r.pane.transcript.at(-1)).toBe("> a message from walky talky");
  });

  /** A held phone command at the head of the queue: it joins behind a held send, which the person then cancels. */
  async function heldCommand(r: Rig, text: string): Promise<string> {
    const ahead = await heldInTurn(r, "a send ahead of it");
    const id = `held-${String(++ids).padStart(6, "0")}`;
    expect((await r.send(text, { id, mode: "command", fromPhone: true })).receipt).toMatchObject({ outcome: "held", keys: [] });
    expect(r.protocol.cancelHeld("main", "%1", ahead)).toMatchObject({ result: "cancelled" });
    expect(r.holds.list().map((entry) => entry.id)).toEqual([id]);
    return id;
  }

  test("INTURN-4 a held phone command (mode command, text `/compact`) waits for the turn to end", async () => {
    const r = rig();
    const id = await heldCommand(r, "/compact");
    r.pane.answerDialog();
    for (let i = 0; i < 6; i++) expect(await r.tick()).toEqual([]);
    expect(r.pane.calls).toEqual([]);
    expect(r.pane.keysSeen).toEqual([]);
    expect(r.holds.get(id)?.state).toBe("held");
    r.pane.endTurn();
    const sent: (SendAnswer | null)[] = [];
    for (let i = 0; i < 8 && r.holds.list().length > 0; i++) sent.push(...(await r.tick()));
    expect(sent.find((answer) => answer !== null)?.receipt).toMatchObject({ requestId: id, outcome: "sent" });
    expect(r.pane.queued).toEqual([]);
    expect(r.pane.transcript.at(-1)).toBe("> /compact");
  });

  test("INTURN-4 a phone text that starts with `/` in mode send is never held: refused reserved_lead before any key", async () => {
    const r = rig();
    await heldInTurn(r, "a send ahead of it");
    const answer = await r.send("/compact", { id: "slash-as-send-01", fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "reserved_lead", keys: [] });
    expect(r.holds.get("slash-as-send-01")).toBeNull();
    expect(r.pane.calls).toEqual([]);
    expect(r.pane.keysSeen).toEqual([]);
  });

  test("INTURN-5 Claude with a version Collie could not read: a held phone send waits for the turn to end", async () => {
    const r = rig({ version: null });
    r.pane.running = true;
    const id = "held-unread-01";
    const answer = await r.send("also check the lint output", { id, fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: "held", keys: [] });
    expect(r.holds.get(id)?.cause).toBe("turn_running");
    for (let i = 0; i < 6; i++) expect(await r.tick()).toEqual([]);
    expect(r.pane.calls).toEqual([]);
    expect(r.pane.keysSeen).toEqual([]);
    r.pane.endTurn();
    expect(await r.tick()).toEqual([]);
    const [released] = await r.tick();
    expect(released?.receipt).toMatchObject({ requestId: id, outcome: "sent" });
    expect(r.pane.transcript.at(-1)).toBe("> also check the lint output");
  });

  test("INTURN-5 a profile whose harness takes nothing in a turn (no `queues`, no queue key): a held phone send waits for the turn to end", async () => {
    const r = rig({ edit: takesNothingInTurn });
    r.pane.running = true;
    const id = "held-steers-01";
    const answer = await r.send("also check the lint output", { id, fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: "held", keys: [] });
    for (let i = 0; i < 6; i++) expect(await r.tick()).toEqual([]);
    expect(r.pane.calls).toEqual([]);
    expect(r.pane.keysSeen).toEqual([]);
    r.pane.endTurn();
    expect(await r.tick()).toEqual([]);
    const [released] = await r.tick();
    expect(released?.receipt).toMatchObject({ requestId: id, outcome: "sent" });
    expect(r.pane.transcript.at(-1)).toBe("> also check the lint output");
  });

  test("INTURN-6 in-turn releases that meet a dialog at S0 press nothing, go back held, spend no tries; after the turn it is sent", async () => {
    const r = rig();
    const id = await heldInTurn(r, "also check the lint output");
    // Every poll reads the turn free, but a dialog draws again before each release's own S0.
    let attempts = 0;
    for (let i = 0; i < 16; i++) {
      for (const answer of await r.tick(IN_TURN_FREE_SURFACE)) {
        if (answer === null) continue;
        attempts++;
        expect(answer.receipt).toMatchObject({ requestId: id, outcome: "held", keys: [] });
      }
    }
    // More in-turn releases than HOLD_TRIES (5) ran, and each one met the dialog.
    expect(attempts).toBeGreaterThan(5);
    expect(r.pane.calls).toEqual([]);
    expect(r.pane.keysSeen).toEqual([]);
    expect(r.holds.get(id)?.state).toBe("held");
    // The dialog closes and the turn ends: it goes.
    r.pane.answerDialog();
    r.pane.endTurn();
    const sent: (SendAnswer | null)[] = [];
    for (let i = 0; i < 6 && r.holds.list().length > 0; i++) sent.push(...(await r.tick()));
    expect(sent.find((answer) => answer !== null)?.receipt).toMatchObject({ requestId: id, outcome: "sent" });
    expect(r.pane.transcript.at(-1)).toBe("> also check the lint output");
    expect(r.holds.list()).toEqual([]);
  });

  test("INTURN-7 a marked send held over a draft keeps its own rules: not released into the turn the draft started", async () => {
    const r = rig();
    r.pane.box = "fix the parser";
    const id = "held-marked-01";
    const answer = await r.send("from walky", { id, draftHolds: true, holdUntil: r.clock.now + 60 * 60 * 1000, fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: "held" });
    expect(r.holds.get(id)).toMatchObject({ draftHolds: true, cause: "draft_present" });
    const calls = r.pane.calls.length;
    const keys = r.pane.keysSeen.length;
    // The person submits the draft at the desk: a turn starts over an empty box.
    r.pane.transcript.push("> fix the parser");
    r.pane.box = "";
    r.pane.running = true;
    expect(r.read()).toMatchObject(IN_TURN_FREE);
    for (let i = 0; i < 6; i++) expect(await r.tick()).toEqual([]);
    expect(r.pane.calls.slice(calls)).toEqual([]);
    expect(r.pane.keysSeen.slice(keys)).toEqual([]);
    expect(r.pane.queued).toEqual([]);
    r.pane.endTurn();
    const sent: (SendAnswer | null)[] = [];
    for (let i = 0; i < 6 && r.holds.list().length > 0; i++) {
      r.clock.now += 1000;
      sent.push(...(await r.tick()));
    }
    expect(sent.find((one) => one !== null)?.receipt).toMatchObject({ requestId: id, outcome: "sent" });
    expect(r.pane.transcript.at(-1)).toBe("> from walky");
  });

  test("INTURN-8 in-turn releases that keep failing at S0 stop after exactly 8 (IN_TURN_RELEASES), spend no tries, and it goes after the turn", async () => {
    const r = rig();
    const id = await heldInTurn(r, "also check the lint output");
    let attempts = 0;
    for (let i = 0; i < 40; i++) {
      for (const answer of await r.tick(IN_TURN_FREE_SURFACE)) {
        if (answer === null) continue;
        attempts++;
        expect(answer.receipt).toMatchObject({ requestId: id, outcome: "held", keys: [] });
      }
    }
    expect(attempts).toBe(8);
    expect(r.pane.calls).toEqual([]);
    expect(r.pane.keysSeen).toEqual([]);
    expect(r.holds.get(id)?.state).toBe("held");
    // It spent no HOLD_TRIES try on those in-turn attempts.
    expect(r.holds.get(id)?.tries).toBe(0);
    r.pane.answerDialog();
    r.pane.endTurn();
    const sent: (SendAnswer | null)[] = [];
    for (let i = 0; i < 6 && r.holds.list().length > 0; i++) sent.push(...(await r.tick()));
    expect(sent.find((answer) => answer !== null)?.receipt).toMatchObject({ requestId: id, outcome: "sent" });
    expect(r.pane.transcript.at(-1)).toBe("> also check the lint output");
    expect(r.holds.list()).toEqual([]);
  });

  for (const [label, headText, headOver, headSent] of [
    ["a send without fromPhone", "a message from walky talky", {}, "> a message from walky talky"],
    ["a phone command", "/compact", { mode: "command", fromPhone: true }, "> /compact"],
  ] as const) {
    test(`INTURN-9 a phone send behind a head that may not go into a turn (${label}) goes into the turn ahead of it; the head goes after the turn`, async () => {
      const r = rig();
      let head: string;
      if (headOver.mode === "command") {
        // A phone command is held only behind another held request: hold one, put the command behind it, cancel the first.
        const ahead = await heldInTurn(r, "a send ahead of it");
        head = `held-${String(++ids).padStart(6, "0")}`;
        expect((await r.send(headText, { id: head, ...headOver })).receipt).toMatchObject({ outcome: "held", keys: [] });
        expect(r.protocol.cancelHeld("main", "%1", ahead)).toMatchObject({ result: "cancelled" });
      } else {
        head = await heldInTurn(r, headText, headOver);
      }
      const phone = `held-${String(++ids).padStart(6, "0")}`;
      expect((await r.send("and add a test for it", { id: phone, fromPhone: true })).receipt).toMatchObject({ outcome: "held", keys: [] });
      expect(r.holds.list().map((entry) => entry.id)).toEqual([head, phone]);
      r.pane.answerDialog();
      expect(await r.tick()).toEqual([]);
      const [released] = await r.tick();
      expect(released?.receipt).toMatchObject({ requestId: phone, outcome: "sent", queued: true });
      expect(r.pane.running).toBe(true);
      expect(r.pane.queued).toEqual(["and add a test for it"]);
      // The head stays held while the turn runs.
      for (let i = 0; i < 6; i++) expect(await r.tick()).toEqual([]);
      expect(r.holds.list().map((entry) => `${entry.id} ${entry.state}`)).toEqual([`${head} held`]);
      r.pane.endTurn();
      const sent: (SendAnswer | null)[] = [];
      for (let i = 0; i < 8 && r.holds.list().length > 0; i++) sent.push(...(await r.tick()));
      expect(sent.find((answer) => answer !== null)?.receipt).toMatchObject({ requestId: head, outcome: "sent" });
      expect(r.pane.transcript.at(-1)).toBe(headSent);
      expect(r.holds.list()).toEqual([]);
    });
  }

  test("INTURN-10 after a bridge restart (a new HoldStore and SendProtocol over the same directory) the held phone send goes into the turn", async () => {
    const before = rig();
    const id = await heldInTurn(before, "also check the lint output");
    // The bridge restarts: the pane and the clock go on, the stores are read back from disk.
    const r = rig({ pane: before.pane, clock: before.clock });
    expect(r.holds.get(id)?.state).toBe("held");
    r.pane.answerDialog();
    expect(await r.tick()).toEqual([]);
    const [released] = await r.tick();
    expect(released?.receipt).toMatchObject({ requestId: id, outcome: "sent", queued: true });
    expect(r.pane.running).toBe(true);
    expect(r.pane.queued).toEqual(["also check the lint output"]);
    expect(r.holds.list()).toEqual([]);
  });

  test("INTURN-10 a held file written without the intoTurn field (an old entry) waits for the turn to end after the restart", async () => {
    const before = rig();
    const id = await heldInTurn(before, "also check the lint output");
    const file = join(dir, "held", `${id}.json`);
    const stored = asJsonObject(JSON.parse(readFileSync(file, "utf8")));
    expect(stored).toBeDefined();
    const old = Object.fromEntries(Object.entries(stored ?? {}).filter(([key]) => key !== "intoTurn"));
    writeFileSync(file, JSON.stringify(old), { mode: 0o600 });
    const r = rig({ pane: before.pane, clock: before.clock });
    expect(r.holds.get(id)?.state).toBe("held");
    r.pane.answerDialog();
    for (let i = 0; i < 6; i++) expect(await r.tick()).toEqual([]);
    expect(r.pane.calls).toEqual([]);
    expect(r.pane.keysSeen).toEqual([]);
    r.pane.endTurn();
    const sent: (SendAnswer | null)[] = [];
    for (let i = 0; i < 6 && r.holds.list().length > 0; i++) sent.push(...(await r.tick()));
    expect(sent.find((answer) => answer !== null)?.receipt).toMatchObject({ requestId: id, outcome: "sent" });
    expect(r.pane.transcript.at(-1)).toBe("> also check the lint output");
  });

  test("INTURN-11 a person's sends keep their order: B never goes into the turn ahead of A once A's in-turn releases are spent", async () => {
    const r = rig();
    const a = await heldInTurn(r, "first thought");
    const b = `held-${String(++ids).padStart(6, "0")}`;
    expect((await r.send("second thought", { id: b, fromPhone: true })).receipt).toMatchObject({ outcome: "held", keys: [] });
    // A's in-turn releases meet the dialog at S0 until they are spent (IN_TURN_RELEASES, as in INTURN-8).
    let attempts = 0;
    for (let i = 0; i < 40; i++) {
      for (const answer of await r.tick(IN_TURN_FREE_SURFACE)) {
        if (answer === null) continue;
        attempts++;
        expect(answer.receipt).toMatchObject({ requestId: a, outcome: "held", keys: [] });
      }
    }
    expect(attempts).toBe(8);
    // The dialog clears while the turn still runs: the polls read the turn free, and nothing jumps A.
    r.pane.answerDialog();
    expect(r.read()).toMatchObject(IN_TURN_FREE);
    for (let i = 0; i < 8; i++) expect(await r.tick()).toEqual([]);
    expect(r.pane.queued).toEqual([]);
    expect(r.pane.calls).toEqual([]);
    expect(r.holds.list().map((entry) => `${entry.id} ${entry.state}`)).toEqual([`${a} held`, `${b} held`]);
    // The turn ends: A goes first, then B.
    r.pane.endTurn();
    const sent: string[] = [];
    for (let i = 0; i < 30 && r.holds.list().length > 0; i++) {
      for (const answer of await r.tick()) if (answer?.receipt?.outcome === "sent") sent.push(answer.receipt.requestId);
    }
    expect(sent).toEqual([a, b]);
    expect(r.pane.transcript.slice(-2)).toEqual(["> first thought", "> second thought"]);
    expect(r.pane.queued).toEqual([]);
  });

  test("INTURN-12 an in-turn release whose submit key does not take ends with its own outcome, not held again; the phone send behind it waits while the box holds that text", async () => {
    const r = rig();
    const a = await heldInTurn(r, "first thought");
    const b = `held-${String(++ids).padStart(6, "0")}`;
    expect((await r.send("second thought", { id: b, fromPhone: true })).receipt).toMatchObject({ outcome: "held", keys: [] });
    r.pane.answerDialog();
    // The box ignores the next submit key once: the text stays in it.
    r.pane.ignoreEnter = 1;
    expect(await r.tick()).toEqual([]);
    const [released] = await r.tick();
    const outcome = released?.receipt?.outcome;
    // The decision names typed_not_submitted; a queued send whose text stays in the box may also read
    // unknown(dialog_after_enter) today. Either way it is an end, never sent, never held again.
    expect(["typed_not_submitted", "unknown"]).toContain(outcome ?? "none");
    expect(released?.receipt?.requestId).toBe(a);
    expect(released?.receipt?.keys).toContain("Enter");
    expect(r.pane.box).toBe("first thought");
    expect(r.pane.queued).toEqual([]);
    expect(r.holds.get(a)).toMatchObject({ state: "ended", outcome });
    // B is next, but the box holds A's text: nothing goes into the turn, nothing is typed over it.
    const calls = r.pane.calls.length;
    const keys = r.pane.keysSeen.length;
    for (let i = 0; i < 6; i++) expect(await r.tick()).toEqual([]);
    expect(r.pane.calls.slice(calls)).toEqual([]);
    expect(r.pane.keysSeen.slice(keys)).toEqual([]);
    expect(r.pane.queued).toEqual([]);
    expect(r.holds.get(b)?.state).toBe("held");
  });
});
