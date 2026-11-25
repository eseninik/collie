// Oracle: finding 6 in collie-1290-fix-brief.md; the ordinary phone path refuses the theme modal.
// Written before the fix, without reading implementation.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture, ReviewPane, reviewRig } from "./protocol.review-fix.test.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "collie-theme-fix-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

for (const width of [40, 61]) {
  test(`FIX-THEME-PHONE @oracle:requirement w${String(width)}: an ordinary Claude phone send refuses the first-run theme question without typing`, async () => {
    const pane = new ReviewPane(() => capture(`claude--v2325-first-run-theme--w${String(width)}.txt`));
    const { send, holds } = reviewRig(dir, pane, "claude", "2.1.325");
    const answer = await send("hello", { fromPhone: true });
    expect(answer.surface).toMatchObject({ modal: { ask: { kind: "question", channel: "keys" } } });
    expect(answer.receipt).toMatchObject({ outcome: "refused", keys: [] });
    expect(pane.writes).toEqual([]);
    expect(pane.keys).toEqual([]);
    expect(holds.waiting("main", "%1")).toEqual([]);
  });
}
