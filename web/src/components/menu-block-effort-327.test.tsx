// Oracle: owner report, item 9 in collie-1290-fix-brief.md. Written before implementation changes.
// The printed scale uses chips in the existing phone card; they emit the advertised arrow keys.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { buildBlocks } from "@/lib/harness";
import { MenuBlock } from "./menu-block";

const CAPTURE = readFileSync(join(import.meta.dirname, "../fixtures/panes/claude--v2327-effort-dialog.ansi.txt"), "utf8");

describe("@req:FIX-EFFORT-327 @oracle:requirement the phone card for the real Claude 2.1.327 effort dialog", () => {
  it("exposes Left, Right, session-only, save and cancel as the screen's keys", async () => {
    const block = buildBlocks(splitLines(parseAnsi(CAPTURE)), { agent: "claude" }).find((item) => item.kind === "menu");
    expect(block).toBeDefined();
    if (block?.kind !== "menu") throw new Error("the captured effort dialog must lift a menu card");
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(<MenuBlock menu={block.menu} lines={block.lines} onAction={onAction} />);
    expect(screen.getByText("Effort")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "medium, current" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "adjust to low" }));
    expect(onAction).toHaveBeenLastCalledWith({ keys: ["Left"], nav: true });
    await user.click(screen.getByRole("button", { name: "adjust to high" }));
    expect(onAction).toHaveBeenLastCalledWith({ keys: ["Right"], nav: true });
    for (const key of ["s", "Enter", "Escape"]) {
      const action = block.menu.actions.find((item) => item.keys.length === 1 && item.keys[0] === key);
      expect(action, `the footer's ${key} action`).toBeDefined();
      if (action === undefined) throw new Error(`the card needs the printed ${key} action`);
      await user.click(screen.getByRole("button", { name: action.label }));
      expect(onAction).toHaveBeenLastCalledWith({ keys: [key], nav: false });
    }
  });
});
