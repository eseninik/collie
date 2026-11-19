// Oracle: finding 6 in collie-1290-r2-brief.md and the real default-mode Claude Code screen.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { buildBlocks } from "@/lib/harness";
import { MenuBlock } from "./menu-block";

const CAPTURE = readFileSync(join(import.meta.dirname, "../fixtures/panes/claude--v2327-effort-dialog-default.ansi.txt"), "utf8");

// Oracle: finding 4 in collie-1290-r3-brief.md requires real colour in the default-mode capture.
it("@req:FIX-EFFORT-COLOR @oracle:requirement captures the selected Effort level with a foreground SGR code", () => {
  const foreground = new RegExp(`${String.fromCodePoint(0x1b)}\\[38;2;\\d+;\\d+;\\d+mmedium`, "u");
  expect(CAPTURE).toMatch(foreground);
});

describe("@req:R2-EFFORT-DEFAULT @oracle:requirement the phone card for Claude Code 2.1.327 in default mode", () => {
  it("shows the effort scale and sends the keys printed on the menu", async () => {
    const blocks = buildBlocks(splitLines(parseAnsi(CAPTURE)), { agent: "claude" });
    const menus = blocks.filter((block) => block.kind === "menu");
    expect(menus).toHaveLength(1);
    const block = menus[0];
    if (block === undefined) throw new Error("the captured Effort dialog must lift a menu card");
    expect(block.menu.signature).toContain("Effort");
    expect(block.menu.signature).toContain("←/→ to adjust");
    expect(block.menu.signature).not.toContain("❯");
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(<MenuBlock menu={block.menu} lines={block.lines} onAction={onAction} />);
    expect(screen.getByText("Effort")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "medium, current" })).toBeDisabled();
    for (const level of ["low", "high", "xhigh", "max"]) {
      expect(screen.getByRole("button", { name: `adjust to ${level}` })).toBeEnabled();
    }
    await user.click(screen.getByRole("button", { name: "adjust to low" }));
    expect(onAction).toHaveBeenLastCalledWith({ keys: ["Left"], nav: true });
    await user.click(screen.getByRole("button", { name: "adjust to high" }));
    expect(onAction).toHaveBeenLastCalledWith({ keys: ["Right"], nav: true });
    for (const key of ["s", "Enter", "Escape"]) {
      const action = block.menu.actions.find((item) => item.keys.length === 1 && item.keys[0] === key);
      if (action === undefined) throw new Error(`the card needs the printed ${key} action`);
      await user.click(screen.getByRole("button", { name: action.label }));
      expect(onAction).toHaveBeenLastCalledWith({ keys: [key], nav: false });
    }
    expect(onAction).toHaveBeenCalledTimes(5);
  });
});
