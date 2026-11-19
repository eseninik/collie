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
  // R2 permits a frame that moves once and settles. Alternate the two positions so the
  // frame is still moving on the retry as well, and must receive no text or key.
  const pane = new ReviewPane((read) => read % 2 === 1 ? screen : `\n${screen}`);
  const { send } = reviewRig(dir, pane, "claude", "2.1.325");
  const answer = await send("synthetic-code");
  expect(pane.reads).toBeGreaterThanOrEqual(2);
  expect(pane.writes).toEqual([]);
  expect(pane.keys).toEqual([]);
  expect(answer.receipt).toMatchObject({ outcome: "refused", keys: [] });
});

// Oracle: R2 finding 1 and no-secret-field.test.ts require the code to stay out of the editor.
test("@req:R2-SECRET-STABILITY @oracle:requirement a sign-in code never goes into the editor that replaces the sign-in screen", async () => {
  const signIn = capture("claude--v2325-login-url--w61.txt");
  const editor = capture("claude--done.txt");
  const ready = await reviewRig(dir, new ReviewPane(() => editor), "claude", "2.1.325")
    .send("", { mode: "prepare" });
  expect(ready.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
  expect(ready.surface?.field).toBeUndefined();

  // The first read sees the sign-in field. The pane then stays in its ordinary editor.
  const pane = new ReviewPane((read) => read === 1 ? signIn : editor);
  const { send } = reviewRig(dir, pane, "claude", "2.1.325");
  const answer = await send("synthetic-code", { secret: true });
  expect(pane.reads).toBeGreaterThanOrEqual(2);
  expect(pane.writes).toEqual([]);
  expect(pane.keys).toEqual([]);
  expect(answer.receipt).toMatchObject({ outcome: "refused", keys: [] });
});
