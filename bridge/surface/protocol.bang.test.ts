// Shell lines in the real Claude and OMP screen captures.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { profileFor } from "../../web/src/lib/surface/profile.ts";
import { neverHeldEntry } from "./protocol.ts";
import { FakePane, LIVE_ROW, PROBE, neverEscape, rig, useScratchDir } from "./protocol.rig.ts";

useScratchDir();

describe("Claude Code 2.1.319, a `!` shell line over its path completion row (owner's pane, 2026-11-09)", () => {
  const FIXTURES = join(import.meta.dir, "fixtures");
  const TYPED = readFileSync(join(FIXTURES, "claude--v2319-bang-path-completion--w120.txt"), "utf8").replace(/\n$/u, "");
  const PATH = "/tmp/claude-1000/-home-admin-projects-ss-form/45649e85-9af7-4fcd-b8ab-dfb5bc6ee83a/scratchpad/drive-spike.sh";
  const TEXT = `! sudo bash ${PATH}`;
  const LIST_ELSEWHERE = "The command list at the box pointed at another command, so Enter was not pressed.";
  const rows = TYPED.split("\n");
  const EDGE = rows[0]!;
  const emptyScreen = [EDGE, "❯ ", EDGE].join("\n");
  const probeScreen = [EDGE, `❯ ${PROBE}`, EDGE].join("\n");

  /** A pane whose reads are the empty box, the probe in it, or `typed` once the box holds `text`. */
  const replay = (text: string, typed: string): FakePane => {
    const pane = new FakePane("claude");
    pane.collapseOver = 100_000;
    let entered = false;
    pane.afterInput = (_p, what) => {
      if (what === "keys:Enter") entered = true;
    };
    pane.beforeRead = (p) => {
      if (entered || p.box === "") p.fixed = emptyScreen;
      else if (p.box === PROBE) p.fixed = probeScreen;
      else if (p.box === text) p.fixed = typed;
      else throw new Error(`the pane never showed the box holding ${JSON.stringify(p.box)}`);
    };
    return pane;
  };

  test("the capture is the owner's screen: the box holds the line, and the one row under it points at the line's last word", () => {
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatch(/^─{40,}$/u);
    expect(rows[1]).toBe("!  sudo bash");
    expect(rows[2]).toBe(`  ${PATH}`);
    expect(rows[3]).toBe(EDGE);
    expect(rows[4]).toBe(`  ❯ ${PATH}`);
    expect(TEXT).toHaveLength(120);
    expect(TEXT.split(" ").at(-1)).toBe(PATH);
  });

  test("@oracle:requirement @req:BANG-PATH-1 a `!` line whose completion pointer is its own last word goes in with Enter, sent", async () => {
    const pane = replay(TEXT, TYPED);
    const answer = await rig({ pane, version: "2.1.319" }).send(TEXT, { mode: "command" });
    expect(answer.receipt).toMatchObject({ profileStatus: "provisional", outcome: "sent" });
    expect(answer.detail).not.toBe(LIST_ELSEWHERE);
    expect(answer.receipt?.keys.at(-1)).toBe("Enter");
    expect(pane.keysSeen.filter((key) => key === "Enter")).toHaveLength(1);
    expect(pane.keysSeen).not.toContain("Tab");
    expect(pane.keysSeen).not.toContain("Escape");
    // The line went in as typed: Enter on the completion row did not swap the path.
    expect(pane.transcript.at(-1)).toBe(`> ${TEXT}`);
  });

  // Lab 2026-11-09, Claude Code 2.1.319 in tmux, 120 columns, and the owner's pane the same day: in bash
  // mode Enter submits the line as typed and never takes the completion under the box. `! ls <dir>/subdir`
  // under `❯ …ome-admin-…/lab-dir/subdir/` ran `ls <dir>/subdir`; `! ls <dir>/sub` under the same row ran
  // `ls <dir>/sub` (No such file or directory). The owner's `! rm -rf /home/admin/projects/case-passport`
  // under `❯ /home/admin/projects/case-passport/` ended typed_not_submitted (LIST_ELSEWHERE) before this.
  /** One send of `text` over a typed screen of the owner's box with `box` as its rows and `under` under it. */
  const sendOver = async (text: string, under: readonly string[], box: readonly string[] = [`!  ${text.slice(2)}`]) => {
    const pane = replay(text, [EDGE, ...box, EDGE, ...under].join("\n"));
    const answer = await rig({ pane, version: "2.1.319" }).send(text, { mode: "command" });
    return { pane, answer };
  };
  const LAB_DIR = "/tmp/claude-1000/-home-admin-projects-lab/lab-dir";
  const LONG = `/tmp/${"x".repeat(100)}`;
  const SIBLING = PATH.replace("drive-spike.sh", "drive-spike2.sh");

  describe("@oracle:requirement @req:BANG-PATH-ENTER a `!` line goes in with Enter whatever completion row stands under the box", () => {
    test.each([
      ["the owner's directory with a trailing slash", "! rm -rf /home/admin/projects/case-passport", ["  ❯ /home/admin/projects/case-passport/"], undefined],
      ["the lab's directory under a `…`-cut pointer with a trailing slash", `! ls ${LAB_DIR}/subdir`, ["  ❯ …ome-admin-…/lab-dir/subdir/"], undefined],
      ["the lab's prefix of that directory under the same pointer", `! ls ${LAB_DIR}/sub`, ["  ❯ …ome-admin-…/lab-dir/subdir/"], undefined],
      ["a prefix whose pointer shows the whole file name", "! sudo bash /tmp/dri", ["  ❯ /tmp/drive-spike.sh"], undefined],
      ["a pointer on a sibling file", TEXT, [`  ❯ ${SIBLING}`], ["!  sudo bash", `  ${PATH}`]],
      ["a pointer on a path in the line that is not its last word", `${TEXT} --dry-run`, [`  ❯ ${PATH}`], ["!  sudo bash", `  ${PATH} --dry-run`]],
      ["a pointer on a path with a space, read short at the space", "! cat /tmp/my", ["  ❯ /tmp/my file.sh"], undefined],
      ["an absolute pointer that only ends the typed word", "! cat /a//tmp/x", ["  ❯ /tmp/x"], undefined],
      ["a pointed path that goes on in a wrapped row", `! cat ${LONG}`, [`  ❯ ${LONG}`, "        y-continued.sh"], undefined],
    ] as const)("%s: sent, Enter once, the line as typed", async (_name, text, under, box) => {
      const { pane, answer } = await sendOver(text, under, box);
      expect(answer.receipt).toMatchObject({ outcome: "sent" });
      expect(answer.detail).not.toBe(LIST_ELSEWHERE);
      expect(answer.receipt?.keys.at(-1)).toBe("Enter");
      expect(pane.keysSeen.filter((key) => key === "Enter")).toHaveLength(1);
      expect(pane.keysSeen).not.toContain("Tab");
      expect(pane.keysSeen).not.toContain("Escape");
      expect(pane.transcript.at(-1)).toBe(`> ${text}`);
    });
  });
});

// The OMP path rule (`notForText`) is unchanged by the Claude fix: a path text whose last word is a bare
// name, with the list's pointer on that name, is no path completion. Screens: tester 14's `/plan` capture
// (omp 18.12.6, 120 columns), its box text and its pointer row swapped for this text and entry.
describe("@oracle:requirement @req:BANG-PATH-7 OMP: a path text whose last word is a bare name keeps its behaviour", () => {
  const FIXTURES = join(import.meta.dir, "fixtures");
  const capture = (name: string): string => readFileSync(join(FIXTURES, `omp--v18-12-6-plan-on-${name}--w120.txt`), "utf8");
  const TEXT = "~/proj/a.sh foo";

  test("`~/proj/a.sh foo` with the pointer on `foo` under the box is not sent with Enter", async () => {
    const empty = capture("empty");
    const probe = empty.replace(/^╰─.*$/mu, `╰─ ${PROBE}`);
    const typed = capture("slash-plan").replace(/^╰─ \/plan$/mu, `╰─ ${TEXT}`).replace(/^❯ 🗺 {2}plan .*$/mu, "❯ foo");
    expect(typed).toContain(`\n╰─ ${TEXT}\n❯ foo\n`);
    expect(TEXT).toMatch(/^\s*@?(?:~|\.{1,2}|\/[^\s/]+)\//u);
    const pane = new FakePane("generic");
    let entered = false;
    pane.afterInput = (_p, what) => {
      if (what === "keys:Enter") entered = true;
    };
    pane.beforeRead = (p) => {
      if (entered) p.fixed = capture("slash-plan-sent");
      else if (p.box === "") p.fixed = empty;
      else if (p.box === PROBE) p.fixed = probe;
      else if (p.box === TEXT) p.fixed = typed;
      else throw new Error(`the screen never showed the box holding ${JSON.stringify(p.box)}`);
    };
    const answer = await rig({ pane, harness: "omp", version: "18.12.6" }).send(TEXT);
    // The outcome on the base before the Claude fix (128759f7f), kept: the list is something that opened at the box.
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue", keys: ["probe", "Backspace"] });
    expect(answer.receipt?.detail).toBe("Something opened at the box after the text was typed, so Enter was not pressed.");
    expect(pane.keysSeen).not.toContain("Enter");
  });
});

// Owner's decision, 2026-11-09 ("я не могу отправить команду", twice while a Claude turn ran): on Claude a
// `!` shell line in a running turn is typed and entered, and Claude Code queues it. Live, Claude Code
// 2.1.319 over Herdr, pane ss-form w4:p1, 120 columns: Enter on a box holding the line in a turn printed
// the line verbatim with `  ctrl+q to send now` under it, the box showed `❯ Press up to edit queued
// messages`, and the line ran after the turn. The screen after Enter is that pane's rows
// (claude--v2319-bang-queued--w120.txt); the screens before it are the same spinner and footer around
// the box, drawn here: the empty box, the probe in it and the typed line. The capture starts at the
// queued line; the conversation above it, which a pane in a turn always shows and which the in-turn
// compare reads (the rows above may only scroll), is drawn here too, the same on every screen.
describe("Claude Code 2.1.319, a `!` shell line in a running turn is queued (owner, 2026-11-09)", () => {
  const FIXTURES = join(import.meta.dir, "fixtures");
  const QUEUED = readFileSync(join(FIXTURES, "claude--v2319-bang-queued--w120.txt"), "utf8").replace(/\n$/u, "");
  const PATH = "/tmp/claude-1000/-home-admin-projects-ss-form/45649e85-9af7-4fcd-b8ab-dfb5bc6ee83a/scratchpad/drive-spike.sh";
  const NEVER_HELD = "Collie does not queue this command during a turn. Send it when the turn ends.";
  const queuedRows = QUEUED.split("\n");
  const EDGE = queuedRows[7]!;
  const SPIN = queuedRows.slice(4, 7);
  const FOOT = queuedRows.slice(10);
  const CONVERSATION = ["❯ run the drive spike once the build is green", "", "● Building the bundle first, then the spike.", "  The build takes about a minute.", ""];
  const running = (box: readonly string[], under: readonly string[] = FOOT): string => [...CONVERSATION, ...SPIN, EDGE, ...box, EDGE, ...under].join("\n");
  const afterEnter = (rows: readonly string[]): string => [...CONVERSATION, ...rows].join("\n");

  /** A pane in a running turn: the empty box, the probe, `typed` once the box holds `text`, `queued` after Enter. */
  const replay = (text: string, typed: string, queued: string): FakePane => {
    const pane = new FakePane("claude");
    pane.collapseOver = 100_000;
    let entered = false;
    pane.afterInput = (_p, what) => {
      if (what === "keys:Enter") entered = true;
    };
    pane.beforeRead = (p) => {
      if (entered) p.fixed = queued;
      else if (p.box === "") p.fixed = running(["❯ "]);
      else if (p.box === PROBE) p.fixed = running([`❯ ${PROBE}`]);
      else if (p.box === text) p.fixed = typed;
      else throw new Error(`the pane never showed the box holding ${JSON.stringify(p.box)}`);
    };
    return pane;
  };

  test("the screen after Enter is the owner's: the line, `ctrl+q to send now`, the spinner, the box's queued hint", () => {
    expect(queuedRows).toHaveLength(12);
    expect(queuedRows[0]).toBe("! sudo bash");
    expect(queuedRows[1]).toBe(`  ${PATH}`);
    expect(queuedRows[2]).toBe("  ctrl+q to send now");
    expect(queuedRows[4]).toMatch(/^✻ Unfurling… \(43s/u);
    expect(EDGE).toMatch(/^─{120}$/u);
    expect(queuedRows[8]).toBe("❯ Press up to edit queued messages");
    expect(queuedRows[9]).toBe(EDGE);
  });

  test("@oracle:requirement @req:BANG-QUEUE-1 `! git status` in a turn is typed and entered once, sent and queued", async () => {
    const text = "! git status";
    const typed = running(["!  git status"]);
    const queued = afterEnter(["! git status", ...queuedRows.slice(2)]);
    const pane = replay(text, typed, queued);
    const answer = await rig({ pane, version: "2.1.319" }).send(text, { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true });
    expect(answer.receipt?.keys.at(-1)).toBe("Enter");
    expect(pane.keysSeen.filter((key) => key === "Enter")).toHaveLength(1);
    neverEscape(pane);
  });

  test("@oracle:requirement @req:BANG-QUEUE-2 the owner's line over its own path completion row in a turn is sent and queued", async () => {
    const text = `! sudo bash ${PATH}`;
    const typed = running(["!  sudo bash", `  ${PATH}`], [`  ❯ ${PATH}`]);
    const pane = replay(text, typed, afterEnter(queuedRows));
    const answer = await rig({ pane, version: "2.1.319" }).send(text, { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true });
    expect(answer.receipt?.keys.at(-1)).toBe("Enter");
    expect(pane.keysSeen.filter((key) => key === "Enter")).toHaveLength(1);
    neverEscape(pane);
  });

  test("@oracle:requirement @req:BANG-QUEUE-3 Claude's session commands stay refused in a turn, and `!` stays never-held on the other profiles", async () => {
    const r = rig({ version: "2.1.319" });
    r.pane.over = [LIVE_ROW];
    for (const command of ["/clear", "/resume", "/exit", "/quit", "/logout", "/branch"]) {
      const answer = await r.send(command, { mode: "command" });
      expect(answer.receipt, command).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
      expect(answer.detail, command).toBe(NEVER_HELD);
    }
    expect(r.pane.calls).toEqual([]);
    for (const harness of ["codex", "muse", "cursor", "kiro", "hermes"]) {
      expect(neverHeldEntry("!git status", profileFor(harness, null, { log: () => undefined })), harness).toBe("!");
    }
  });
});
