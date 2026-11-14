import { describe, expect, it } from "vitest";

import { fixtureRows } from "../../test/surface-corpus";
import { lineText } from "../blocks";
import { codexAdapter } from "./codex";
import { composerPrompt, stripChrome } from "./codex/chrome";
import { buildBlocks } from "./index";

// The adapter is the public screen reader the phone uses. A correct Surface alone does not prove
// that the conversation renderer removes the composer and status rows from the captured pane.
describe("@oracle:requirement @req:A1 Codex 0.169 phone reader", () => {
  it.each([
    "codex--v0169-idle--w120.txt",
    "codex--v0169-idle-tip--w80.txt",
    "codex--v0169-idle-after-turn--w120.txt",
    "codex--v0169-working--w120.txt",
    "codex--v0169-working-queued--w120.txt",
    "codex--v0169-working-queued--w80.txt",
  ])("%s: the real composer is ready, empty, and absent from the conversation body", (name) => {
    const rows = fixtureRows(name);
    expect(codexAdapter.composerReady!(rows)).toBe(true);
    expect(codexAdapter.extractInputDraft(rows)).toBeNull();
    expect(composerPrompt(rows)).toBe("› Ask Codex to do anything");
    expect(buildBlocks(rows, { agent: "codex" }).map((block) => block.kind)).not.toContain("unread-dialog");
    const body = stripChrome(rows).map(lineText).join("\n");
    expect(body).not.toContain("› Ask Codex to do anything");
    expect(body).not.toContain("GPT-6.1-Sol low · weekly");
    expect(body).not.toContain("← for agents · ? for shortcuts");
    expect(body).not.toContain("⚠ 1 warning · f2 to view");
    if (name.includes("w80")) expect(body.split("\n")).not.toContain("  probe");
  });

  it("the narrow status keeps its second line in the status view, never in the draft", () => {
    const rows = fixtureRows("codex--v0169-working-queued--w80.txt");
    expect(codexAdapter.extractStatusLines(rows).map(lineText)).toEqual([
      "  GPT-6.1-Sol low · weekly 39% left · Context 97% left · /tmp/collie-codex169-",
      "  probe",
    ]);
    expect(codexAdapter.extractInputDraft(rows)).toBeNull();
  });

  it("the real dialog does not offer a ready composer", () => {
    expect(codexAdapter.composerReady!(fixtureRows("codex--v0169-model-dialog--w120.txt"))).toBe(false);
  });
});
