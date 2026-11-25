import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProfiles, profileFor, type Profile, type VersionRange } from "../../web/src/lib/surface/profile.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import { surfaceOfScreen } from "../../web/src/lib/surface/fold.ts";
import { muxAck, muxOk } from "../mux/types.ts";
import { ClearService } from "./clear.ts";
import { KeyGate } from "./key-gate.ts";
import { boxMatches, boxMatchesTail } from "./protocol.ts";
import { DIALOG, FakePane, rig, useScratchDir } from "./protocol.rig.ts";

const SENT =
  "This message is long enough that in a small pane it wraps past the height of the Claude Code input box. When that happens Claude Code scrolls the box and draws an up arrow with a count of hidden lines in the top border, and the prompt line with the caret scrolls out of view. Collie looks for that prompt line to find the box, so it cannot find it, and the send stops after typing without pressing Enter.";
const FIXTURE = join(import.meta.dirname, "..", "..", "web", "src", "fixtures", "panes", "claude--v2331-draft-scrolled-up--w59.txt");
const CAPTURE = readFileSync(FIXTURE, "utf8");

describe("Claude Code 2.1.331 box scrolled to `↑ 5 more` after a 404-char send", () => {
  const rows = splitLines(parseAnsi(CAPTURE));
  const read = surfaceOfScreen({ seq: 0, source: "screen", at: 0, revision: 1, rows, ask: null }, loadProfiles().get("claude")!.idle);

  test("the screen reads as an idle box holding a draft, not unknown/no-match", () => {
    expect(read.frame?.scrolled).toBe(true);
    expect(read.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
  });

  test("S1 confirms the send by the tail: the box shows only the end of what was typed", () => {
    const box = read.frame!.interior.text;
    expect(boxMatches(box, "", [SENT], null)).toBe(false);
    expect(boxMatchesTail(box, "", [SENT])).toBe(true);
    expect(boxMatchesTail(box, "", [SENT.replace("without pressing", "after pressing")])).toBe(false);
  });

  test("a view with no text is the tail of nothing", () => {
    expect(boxMatchesTail("", "", [SENT])).toBe(false);
    expect(boxMatchesTail("   ", "", [SENT])).toBe(false);
  });
});

useScratchDir();

const GREY = (s: string): string => `\u001b[38;2;136;136;136m${s}\u001b[0m`;
const RULE = "─".repeat(40);
/** The draft rows the fake box shows before it scrolls. */
const CAP = 3;

/**
 * A Claude pane whose box scrolls as Claude Code 2.1.331 does: past {@link CAP} draft rows the top edge
 * reads `─── ↑ N more ───`, only the last rows stay in view, and the `❯` row leaves the view.
 */
class ScrolledClaudePane extends FakePane {
  override render(): string {
    if (this.dialog !== null || this.box === "") return super.render();
    const rows: string[] = [];
    this.box.split("\n").forEach((line, li) => {
      const chunks = line.length === 0 ? [""] : (line.match(/.{1,38}/gu) ?? [""]);
      chunks.forEach((chunk, ci) => rows.push(li === 0 && ci === 0 ? `❯ ${chunk}` : `  ${chunk}`));
    });
    const out = [...this.transcript, ""];
    if (rows.length <= CAP) out.push(GREY(RULE), ...rows, GREY(RULE));
    else {
      const label = `─── ↑ ${String(rows.length - CAP)} more `;
      const shown = rows.slice(-CAP).map((row) => (row.startsWith("❯") ? `  ${row.slice(2)}` : row));
      out.push(GREY(label + "─".repeat(40 - [...label].length)), ...shown, GREY(RULE));
    }
    out.push(...this.status);
    return out.join("\n");
  }
}

const LONG = "This message is long enough that it wraps past the height of the input box, so the box scrolls and draws an up arrow.";
const idle = loadProfiles().get("claude")!.idle;
const readOf = (text: string): ReturnType<typeof surfaceOfScreen> =>
  surfaceOfScreen({ seq: 0, source: "screen", at: 0, revision: 1, rows: splitLines(parseAnsi(text)), ask: null }, idle);

function capturedScrollPane(scrolled: string): FakePane {
  const pane = new FakePane();
  pane.transcript = [];
  // The captured send stayed as literal text. Keep the same footer when the box is empty.
  pane.collapseOver = SENT.length;
  const rows = CAPTURE.split(/\r?\n/u);
  const bottom = rows.findLastIndex((row) => row.includes("───"));
  pane.render = () => {
    const input = pane.box === "" ? `\u001b[2m${pane.placeholder}\u001b[0m` : pane.box;
    const screen = pane.box === SENT ? scrolled : ["", rows[bottom], `❯ ${input}`, ...rows.slice(bottom)].join("\n");
    return [...pane.transcript, screen].join("\n");
  };
  return pane;
}

describe("a send into a Claude box that scrolls while Collie types", () => {
  test("an empty box, a long send: the box scrolls, S1 confirms by the tail, Enter goes, sent", async () => {
    const pane = new ScrolledClaudePane();
    const { send } = rig({ pane });
    const answer = await send(LONG);
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(answer.receipt?.detail).toContain("compared those with the end of the text");
    expect(pane.transcript.at(-1)).toBe(`> ${LONG}`);
    expect(pane.box).toBe("");
  });

  test("the same send with one word changed in the view: no Enter", async () => {
    const pane = new ScrolledClaudePane();
    pane.afterInput = (p) => {
      p.box = p.box.replace("up arrow", "up arrows");
    };
    const { send } = rig({ pane });
    const answer = await send(LONG);
    expect(answer.receipt?.outcome).not.toBe("sent");
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.transcript.some((row) => row.includes("up arrow"))).toBe(false);
  });

  test("@req:PORT-1301-CLAUDE-SCROLL @oracle:requirement a phone send uses Enter once when the scrolled box shows the captured tail of the reply", async () => {
    const pane = capturedScrollPane(CAPTURE);
    expect(readOf(pane.render()).surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    const answer = await rig({ pane, version: "2.1.331", block: true }).send(SENT, { fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(pane.keysSeen).toEqual(["Enter"]);
    expect(pane.transcript).toEqual([`> ${SENT}`]);
    expect(pane.box).toBe("");
  });

  test("@req:PORT-1301-CLAUDE-SCROLL @oracle:requirement a phone send leaves the reply in place when the scrolled box shows a different tail", async () => {
    const pane = capturedScrollPane(CAPTURE.replace("without pressing Enter.", "after pressing Enter."));
    const answer = await rig({ pane, version: "2.1.331", block: true }).send(SENT, { fromPhone: true });
    expect(answer.receipt).toBeDefined();
    expect(answer.receipt?.outcome).not.toBe("sent");
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.transcript).toEqual([]);
    expect(pane.box).toBe(SENT);
  });

  test("@req:FIX-1301-CLAUDE-SCROLL @oracle:requirement a new phone send replaces its own scrolled reply left by a failed send", async () => {
    const pane = capturedScrollPane(CAPTURE.replace("without pressing Enter.", "after pressing Enter."));
    const { send } = rig({ pane, version: "2.1.331", block: true });

    const first = await send(SENT, { fromPhone: true });
    expect(first.receipt).toMatchObject({ outcome: "typed_not_submitted" });
    expect(readOf(pane.render()).frame?.scrolled).toBe(true);
    expect(pane.box).toBe(SENT);
    expect(pane.keysSeen).toEqual([]);
    expect(pane.transcript).toEqual([]);

    const replacement = "Check the phone layout instead.";
    const second = await send(replacement, { fromPhone: true });
    expect(second.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.keysSeen).toEqual([...Array.from(SENT, () => "Backspace"), "Enter"]);
    expect(pane.transcript).toEqual([`> ${replacement}`]);
    expect(pane.box).toBe("");
  });

  test("@req:FIX-1301-CLAUDE-SCROLL @oracle:requirement a phone send leaves a foreign scrolled draft untouched", async () => {
    const pane = new ScrolledClaudePane();
    const draft = "A draft I typed at the desk\nIt contains enough lines\nto scroll out of the box\nThese last rows are still visible.";
    pane.box = draft;
    expect(readOf(pane.render()).frame?.scrolled).toBe(true);
    const { send } = rig({ pane, version: "2.1.331", block: true });
    const answer = await send("Check the phone layout instead.", { fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present", keys: [] });
    expect(answer.offers).toEqual(["keys"]);
    expect(pane.keysSeen).toEqual([]);
    expect(pane.calls).toEqual([]);
    expect(pane.box).toBe(draft);
  });

  test("@req:FIX-1301-CLAUDE-SCROLL @oracle:requirement a phone send preserves a scrolled reply edited at the terminal after a failed send", async () => {
    const leftOnScreen = CAPTURE.replace("without pressing Enter.", "after pressing Enter.");
    const pane = capturedScrollPane(leftOnScreen);
    const { send } = rig({ pane, version: "2.1.331", block: true });
    const first = await send(SENT, { fromPhone: true });
    expect(first.receipt).toMatchObject({ outcome: "typed_not_submitted" });
    expect(pane.box).toBe(SENT);
    expect(pane.keysSeen).toEqual([]);

    const draft = SENT.replace("without pressing Enter.", "after my own edit.");
    const editedOnScreen = CAPTURE.replace("without pressing Enter.", "after my own edit.");
    const render = pane.render;
    pane.box = draft;
    pane.revision++;
    pane.render = () => pane.box === draft ? editedOnScreen : render();
    const edited = readOf(pane.render());
    expect(edited.frame?.scrolled).toBe(true);
    expect(edited.frame?.interior.text).toContain("after my own edit.");
    const writes = [...pane.calls];

    const second = await send("Check the phone layout instead.", { fromPhone: true });
    expect(second.receipt).toMatchObject({ outcome: "refused", reason: "draft_present", keys: [] });
    expect(second.offers).toEqual(["keys"]);
    expect(pane.keysSeen).toEqual([]);
    expect(pane.calls).toEqual(writes);
    expect(pane.transcript).toEqual([]);
    expect(pane.box).toBe(draft);
  });

  test.each([
    ["the person's draft ending in blank rows (a scrolled box whose view is blank) is no empty box: refused, no key", {}],
    ["@req:PORT-1301-CLAUDE-SCROLL @oracle:requirement a phone send refuses before any write when blank visible rows hide an existing draft", { fromPhone: true }],
  ] as const)("%s", async (_name, request) => {
    const pane = new ScrolledClaudePane();
    const draft = "rm -rf the build folder and then push to main\nsecond line of my own words\n\n\n";
    pane.box = draft;
    const s0 = readOf(pane.render());
    expect(s0.frame?.scrolled).toBe(true);
    expect(s0.frame?.interior.text).toBe("");
    expect(s0.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
    const { send } = rig({ pane });
    const answer = await send("yes please", request);
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present", keys: [] });
    expect(pane.calls).toEqual([]);
    expect(pane.keysSeen).toEqual([]);
    expect(pane.box).toBe(draft);
  });

  test("a `↑ N more` row and a rule in the transcript over a dialog make no box: the screen reads as with none", () => {
    const pane = new ScrolledClaudePane();
    pane.transcript = ["> an earlier question", "─── ↑ 5 more ───────────────────────────", "  of view. Collie looks for that prompt", "  typing without pressing Enter.", RULE];
    pane.dialog = DIALOG;
    const read = readOf(pane.render());
    expect(read.frame).toBeNull();
    expect(read.surface).toMatchObject({ turn: "unknown", modal: "unreadable", composer: "unknown" });
  });

  test("Clear on the person's scrolled draft is refused before any key: nothing deleted", async () => {
    const pane = new ScrolledClaudePane();
    const draft = "HEAD my own long draft at the desk, the first part matters and it goes on past the cap of three rows of the box, so more words here, TAIL";
    pane.box = draft;
    const written: string[] = [];
    const mux = {
      readGrid: (paneId: string) => Promise.resolve(muxOk({ paneId, text: pane.render(), truncated: false, revision: 0 })),
      typeText: (_paneId: string, text: string) => {
        written.push(text);
        return Promise.resolve(muxAck());
      },
      writeKeys: (_paneId: string, keys: readonly string[]) => {
        written.push(...keys);
        return Promise.resolve(muxAck());
      },
    };
    const versions: readonly [VersionRange] = [
      { range: "0.0.0 - *", status: "verified", low: "0.0.0", high: null, verifiedThrough: "2.1.331", verifiedOn: "2026-11-24" },
    ];
    const profiles = new Map<string, Profile>([["claude", { ...loadProfiles().get("claude")!, versions }]]);
    const service = new ClearService({
      staleFrame: () => undefined,
      mux,
      gate: new KeyGate(mux),
      profile: (harness: string) => Promise.resolve(profileFor(harness, "2.1.331", { log: () => undefined, profiles })),
      sleep: () => Promise.resolve(),
    });
    const answer = await service.handle("clr-scrolled", "%1", "claude");
    expect(answer).toMatchObject({ kind: "receipt", receipt: { outcome: "refused", reason: "unreadable" }, pressed: false });
    expect(written).toEqual([]);
    expect(pane.box).toBe(draft);
  });
});
