// Direct phone sends on Claude and Codex, and the controls on other send paths.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { HoldStore } from "./holds.ts";
import { DIALOG, NO_PROFILE, OmpPane, dir, neverEscape, rig, useScratchDir } from "./protocol.rig.ts";

useScratchDir();

// Owner's direct-send acceptance, 2026-11-14, points 1–5. The oracle is the brief,
// written before the implementation by a separate test author.
describe("direct phone send for Claude and Codex (owner 2026-11-14)", () => {
  for (const harness of ["claude", "codex"] as const) {
    const options = harness === "codex" ? { mode: "codex" as const, harness, version: "0.169.0" } : {};
    test(`${harness}: replaces a terminal draft, submits and creates no held row`, async () => {
      const holds = new HoldStore(join(dir, "direct-held"));
      const r = rig({ ...options, holds });
      r.pane.box = "a previous Collie leftover";
      const answer = await r.send("new phone message", { fromPhone: true });
      expect(answer.receipt?.outcome).toBe("sent");
      expect(answer.offers).toEqual([]);
      expect(r.pane.box).toBe("");
      expect(r.pane.transcript.at(-1)).toContain("new phone message");
      expect(r.pane.transcript.at(-1)).not.toContain("leftover");
      expect(holds.list()).toEqual([]);
      neverEscape(r.pane);
    });

    test(`${harness}: a running turn submits in the same request without a hold or poll release`, async () => {
      const holds = new HoldStore(join(dir, "direct-held"));
      const r = rig({ ...options, holds });
      if (harness === "codex") r.pane.over = ["• Working (4s • esc to interrupt)"];
      else {
        r.pane.over = ["✻ Wibbling… (4s · ↓ 304 tokens)"];
        r.pane.drawsQueuedRow = true;
      }
      const answer = await r.send("follow up while working", { fromPhone: true });
      expect(answer.receipt?.outcome).toBe("sent");
      expect(answer.offers).toEqual([]);
      expect(r.pane.keysSeen).toContain(harness === "codex" ? "Tab" : "Enter");
      if (harness === "codex") {
        expect(r.pane.keysSeen).not.toContain("Enter");
        expect(r.pane.queued).toEqual(["follow up while working"]);
      }
      expect(r.pane.box).toBe("");
      expect(holds.list()).toEqual([]);
    });

    test(`${harness}: a direct send bypasses an older Collie hold`, async () => {
      const holds = new HoldStore(join(dir, "direct-held"));
      holds.add({ id: "older-held-0001", session: "main", paneId: "%1", harness, mode: "send", text: "an older external request", revision: 1, command: false });
      const r = rig({ ...options, holds });
      const answer = await r.send("send this phone message now", { fromPhone: true });
      expect(answer.receipt?.outcome).toBe("sent");
      expect(r.pane.box).toBe("");
      expect(r.pane.transcript.at(-1)).toContain("send this phone message now");
      expect(holds.list().map((row) => row.id)).toEqual(["older-held-0001"]);
    });

    test(`${harness}: a modal at the box still refuses without typing or submit`, async () => {
      const r = rig(options);
      r.pane.dialog = DIALOG;
      const answer = await r.send("please continue", { fromPhone: true });
      expect(answer.receipt?.outcome).toBe("refused");
      expect(r.pane.calls).toEqual([]);
      expect(r.pane.keysSeen).not.toContain("Enter");
      expect(r.pane.keysSeen).not.toContain("Tab");
    });

    test(`${harness}: a vanished input box never receives the submit key`, async () => {
      const holds = new HoldStore(join(dir, "direct-held"));
      const r = rig({ ...options, holds });
      r.pane.fixed = "a transcript with no input box";
      const answer = await r.send("please continue", { fromPhone: true });
      expect(answer.receipt?.outcome).not.toBe("sent");
      expect(answer.receipt?.outcome).not.toBe("held");
      expect(r.pane.calls).toEqual([]);
      expect(r.pane.keysSeen).toEqual([]);
      expect(holds.list()).toEqual([]);
    });
  }

  test("Claude: a compare mismatch after typing still submits the text", async () => {
    const r = rig();
    r.pane.dropLastChar = true;
    const answer = await r.send("please send these words", { fromPhone: true });
    expect(answer.receipt?.outcome).toBe("sent");
    expect(answer.offers).toEqual([]);
    expect(r.pane.keysSeen).toContain("Enter");
    expect(r.pane.box).toBe("");
  });

  test("Codex: an idle box that swallowed the first Tab receives one more Tab", async () => {
    const r = rig({ mode: "codex", harness: "codex", version: "0.169.0" });
    let tabs = 0;
    r.pane.beforeWrite = (_pane, what) => {
      if (what === "keys:Tab" && ++tabs === 1) return Promise.resolve();
    };
    const answer = await r.send("long message after a paste", { fromPhone: true });
    expect(answer.receipt?.outcome).toBe("sent");
    expect(tabs).toBe(2);
    expect(r.pane.box).toBe("");
    expect(answer.offers).toEqual([]);
  });

  test("Codex: a box that keeps swallowing Tab is retried only once", async () => {
    const r = rig({ mode: "codex", harness: "codex", version: "0.169.0" });
    let tabs = 0;
    r.pane.beforeWrite = (_pane, what) => {
      if (what === "keys:Tab") {
        tabs++;
        return Promise.resolve();
      }
    };
    const answer = await r.send("never loop on submit", { fromPhone: true });
    expect(answer.receipt?.outcome).not.toBe("sent");
    expect(tabs).toBe(2);
  });

  test("OMP: a phone send onto its draft keeps the refusal and draft", async () => {
    const pane = new OmpPane();
    const r = rig({ pane, harness: "omp", version: "18.12.6" });
    pane.box = "the OMP draft";
    const answer = await r.send("new phone words", { fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
    expect(pane.box).toBe("the OMP draft");
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("Claude: a non-phone send still refuses the existing draft", async () => {
    const r = rig();
    r.pane.box = "terminal draft";
    const answer = await r.send("external caller");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
    expect(r.pane.box).toBe("terminal draft");
    expect(r.pane.keysSeen).not.toContain("Enter");
  });

  test("Claude: a phone slash command keeps the draft refusal path", async () => {
    const r = rig();
    r.pane.box = "terminal draft";
    const answer = await r.send("/model", { mode: "command", fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
    expect(r.pane.box).toBe("terminal draft");
    expect(r.pane.keysSeen).not.toContain("Enter");
  });
});

// Hard stops still dominate direct send even after the full text has been written.
describe("direct send hard stops after typing (owner 2026-11-14)", () => {
  for (const harness of ["claude", "codex"] as const) {
    test(`${harness}: a modal that appears after typing blocks submit`, async () => {
      const r = rig(harness === "codex" ? { mode: "codex", harness, version: "0.169.0" } : {});
      r.pane.afterInput = (pane, what) => {
        if (what.startsWith("paste:")) pane.dialog = DIALOG;
      };
      const answer = await r.send("send after checking the dialog", { fromPhone: true });
      expect(answer.receipt?.outcome).not.toBe("sent");
      expect(r.pane.keysSeen).not.toContain("Enter");
      expect(r.pane.keysSeen).not.toContain("Tab");
    });

    test(`${harness}: a box that vanishes after typing blocks submit`, async () => {
      const r = rig(harness === "codex" ? { mode: "codex", harness, version: "0.169.0" } : {});
      r.pane.afterInput = (pane, what) => {
        if (what.startsWith("paste:")) pane.fixed = "the input box disappeared";
      };
      const answer = await r.send("this text must not submit blindly", { fromPhone: true });
      expect(answer.receipt?.outcome).not.toBe("sent");
      expect(r.pane.keysSeen).not.toContain("Enter");
      expect(r.pane.keysSeen).not.toContain("Tab");
    });
  }
});

// Direct sends must keep the S1 box boundary and the Codex retry boundary.
describe("direct send redraw and retry boundaries (owner 2026-11-14)", () => {
  test("Claude: rows redrawn under the box do not leave a typed draft", async () => {
    const r = rig();
    r.pane.afterInput = (pane, what) => {
      if (what.startsWith("paste:")) pane.popup = ["  src/main.ts", "  src/other.ts"];
    };
    const answer = await r.send("look at main", { fromPhone: true });
    expect(answer.receipt?.outcome).toBe("sent");
    expect(r.pane.keysSeen).toContain("Enter");
    expect(answer.offers).toEqual([]);
  });

  test("Claude: another screen after typing never receives Enter", async () => {
    const r = rig();
    r.pane.afterInput = (pane, what) => {
      if (what.startsWith("paste:")) pane.status = ["  enter to return · Esc to close"];
    };
    const answer = await r.send("not for the agents screen", { fromPhone: true });
    expect(answer.receipt?.outcome).not.toBe("sent");
    expect(r.pane.keysSeen).not.toContain("Enter");
  });

  for (const afterSubmit of ["modal", "no box", "new turn"] as const) {
    test(`Codex: no retry when the first submit is followed by ${afterSubmit}`, async () => {
      const r = rig({ mode: "codex", harness: "codex", version: "0.169.0" });
      let tabs = 0;
      r.pane.beforeWrite = (pane, what) => {
        if (what !== "keys:Tab") return;
        tabs++;
        if (afterSubmit === "modal") pane.dialog = DIALOG;
        if (afterSubmit === "no box") pane.fixed = "input box is gone";
        if (afterSubmit === "new turn") pane.over = ["• Working (4s • esc to interrupt)"];
        return Promise.resolve();
      };
      await r.send("retry only in the idle input box", { fromPhone: true });
      expect(tabs).toBe(1);
    });
  }
});

// Hard-stop answers cannot hand a legacy client an unsafe recovery action.
describe("direct hard-stop replies offer no automatic submit (owner 2026-11-14)", () => {
  for (const boundary of ["modal", "other screen", "no input box"] as const) {
    test(`Claude: ${boundary} after typing never offers Submit or Replace`, async () => {
      const r = rig();
      r.pane.afterInput = (pane, what) => {
        if (!what.startsWith("paste:")) return;
        if (boundary === "modal") pane.dialog = DIALOG;
        if (boundary === "other screen") pane.status = ["  enter to return · Esc to close"];
        if (boundary === "no input box") pane.fixed = "no input box";
      };
      const answer = await r.send("keep the hard stop", { fromPhone: true });
      expect(answer.receipt?.outcome).not.toBe("sent");
      expect(answer.offers).not.toContain("submit");
      expect(answer.offers).not.toContain("replace");
      expect(r.pane.keysSeen).not.toContain("Enter");
    });
  }
});

// The direct-send brief applies to matching profiles and to the first line's
// command route. A later slash-prefixed line remains part of the message body.
describe("direct-send profile and multiline boundaries (owner 2026-11-14)", () => {
  test("a phone send with no profile still sends normally to a bare shell", async () => {
    const r = rig({ mode: "generic", harness: NO_PROFILE });
    r.pane.fixed = "$ ";
    const answer = await r.send("echo hello from the phone", { fromPhone: true });
    expect(answer.receipt?.outcome).toBe("sent");
    expect(answer.offers).toEqual([]);
    expect(r.pane.keysSeen).toEqual(["Enter"]);
    expect(r.pane.transcript.at(-1)).toBe("> echo hello from the phone");
    expect(r.pane.box).toBe("");
  });

  test("Claude: a later slash-prefixed line stays message text while a draft is replaced", async () => {
    const r = rig();
    r.pane.box = "a previous Collie leftover";
    const answer = await r.send("ordinary first line\n/model is text in this message", { fromPhone: true });
    expect(answer.receipt?.outcome).toBe("sent");
    expect(answer.offers).toEqual([]);
    expect(r.pane.transcript.at(-1)).toBe("> ordinary first line /model is text in this message");
    expect(r.pane.box).toBe("");
    expect(r.pane.keysSeen).toContain("Enter");
    neverEscape(r.pane);
  });
});
