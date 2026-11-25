// Oracle: owner report, item 9 in collie-1290-fix-brief.md. Authored on 3e591331b before the fix;
// production implementation and builder notes were not read. These are the owner's unedited captures.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAnsi } from "../../ansi";
import { splitLines } from "../../blocks";
import { buildBlocks } from "../index";
import { adapterFor } from "../registry";
import { verifyExpectedPrompt, verifyPromptBinding } from "../../../../../bridge/prompt-binding";

const FIXTURES = join(import.meta.dirname, "../../../fixtures/panes");
const CAPTURES = ["claude--v2327-effort-dialog.ansi.txt", "claude--v2327-effort-dialog.txt"];
const linesOf = (name: string) => splitLines(parseAnsi(readFileSync(join(FIXTURES, name), "utf8")));

describe("@req:FIX-EFFORT-327 @oracle:requirement Claude 2.1.327 effort over an empty composer", () => {
  it.each(CAPTURES)("%s keeps the captured dialog bindable within the default freshness window", (name) => {
    const rows = readFileSync(join(FIXTURES, CAPTURES[1]!), "utf8").split("\n");
    const title = rows.findIndex((row) => row.trim() === "Effort");
    const footer = rows.findIndex((row) => row.includes("←/→ to adjust"));
    expect(title).toBeGreaterThan(0);
    expect(footer).toBeGreaterThan(title);
    const region = rows.slice(title - 1, footer + 1).join("\n");
    const raw = readFileSync(join(FIXTURES, name), "utf8");
    expect(verifyExpectedPrompt(raw, region)).toEqual({ ok: true });
    expect(verifyPromptBinding(raw, region)).toEqual({ ok: true });
  });

  it.each(CAPTURES)("%s lifts one Effort menu with the printed actions", (name) => {
    const blocks = buildBlocks(linesOf(name), { agent: "claude" });
    const menus = blocks.filter((block) => block.kind === "menu");
    expect(menus).toHaveLength(1);
    expect(blocks.some((block) => block.kind === "unread-dialog")).toBe(false);
    const block = menus[0];
    if (block?.kind !== "menu") throw new Error("the captured effort dialog must lift a menu");
    expect(block.menu.title).toBe("Effort");
    expect(block.menu.nav.leftRight).toMatchObject({
      verb: "adjust",
      label: "medium",
      values: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(block.menu.actions.map((action) => action.keys)).toEqual(expect.arrayContaining([["s"], ["Enter"], ["Escape"]]));
    // The toggle is a separate control, never a sixth effort value.
    expect(block.menu.nav.leftRight?.values).not.toContain("Ultracode");
    expect(block.menu.signature).toContain("Tab to toggle");
    expect(block.menu.signature).not.toContain("❯");
    const raw = readFileSync(join(FIXTURES, name), "utf8");
    // Use the real suffix below the footer and the default freshness window.
    expect(verifyExpectedPrompt(raw, block.menu.signature)).toEqual({ ok: true });
    expect(verifyPromptBinding(raw, block.menu.signature)).toEqual({ ok: true });
  });

  it.each(CAPTURES)("%s forbids message typing while the effort dialog stays above the empty box", (name) => {
    expect(adapterFor("claude")?.composerReady?.(linesOf(name))).toBe(false);
  });

  it("keeps the real empty composer ready after the effort dialog is dismissed", () => {
    const rows = readFileSync(join(FIXTURES, CAPTURES[1]!), "utf8").split("\n");
    const prompt = rows.findIndex((row) => row.trim() === "❯");
    expect(prompt).toBeGreaterThan(0);
    const lines = splitLines(parseAnsi(rows.slice(prompt - 1).join("\n")));
    expect(adapterFor("claude")?.composerReady?.(lines)).toBe(true);
    expect(buildBlocks(lines, { agent: "claude" }).some((block) => block.kind === "menu")).toBe(false);
  });

  it.each([
    ["a real draft in the composer", (raw: string) => raw.replace(/^❯$/mu, "❯ a draft typed at the terminal")],
    ["an unknown row after the effort footer", (raw: string) => raw.replace(/(←\/→ to adjust[^\n]*\n)/u, "$1Unknown terminal continuation\n")],
  ] as const)("does not claim the confirmed empty-box effort layout with %s", (_name, changed) => {
    const raw = readFileSync(join(FIXTURES, CAPTURES[1]!), "utf8");
    const blocks = buildBlocks(splitLines(parseAnsi(changed(raw))), { agent: "claude" });
    expect(blocks.some((block) => block.kind === "menu" && block.menu.title === "Effort")).toBe(false);
  });
});
