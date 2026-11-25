// Oracle: finding 5 in collie-1290-fix-brief.md. Written before the fix, without reading implementation.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture, ReviewPane, reviewRig } from "./protocol.review-fix.test.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "collie-settle-fix-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("FIX-SECRET-SETTLE @oracle:requirement a moving Claude sign-in screen is read twice and receives no text or key", async () => {
  const screen = capture("claude--v2325-login-url--w61.txt");
  // One row is inserted over the entire sign-in screen between the two S0 reads.
  const pane = new ReviewPane((read) => read === 1 ? screen : `\n${screen}`);
  const { send } = reviewRig(dir, pane, "claude", "2.1.325");
  const answer = await send("synthetic-code");
  expect(pane.reads).toBeGreaterThanOrEqual(2);
  expect(pane.writes).toEqual([]);
  expect(pane.keys).toEqual([]);
  expect(answer.receipt).toMatchObject({ outcome: "refused", keys: [] });
});
