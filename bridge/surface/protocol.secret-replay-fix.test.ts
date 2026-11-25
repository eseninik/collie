// Oracle: finding 4 in collie-1290-fix-brief.md. Written on 3e591331b without opening implementation.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture, ReviewPane, reviewRig } from "./protocol.review-fix.test.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "collie-replay-fix-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("FIX-SECRET-REPLAY @oracle:requirement retrying a Claude phone send at sign-in keeps the first answer's offers", async () => {
  const pane = new ReviewPane(() => capture("claude--v2325-login-url--w61.txt"));
  const { send } = reviewRig(dir, pane, "claude", "2.1.325");
  const request = { id: "secret-replay-fix-0001" };
  // A multiline value refuses without leaving the field, so replay sees the same sign-in screen.
  const text = "first synthetic line\nsecond synthetic line";
  const first = await send(text, request);
  expect(first.surface?.field).toBe("secret");
  expect(first.receipt).toMatchObject({ outcome: "refused", reason: "multiline", keys: [] });
  expect(first.offers).toEqual(["keys"]);
  const replay = await send(text, request);
  const afterRestart = await reviewRig(dir, pane, "claude", "2.1.325").send(text, request);
  expect(afterRestart.receipt).toEqual(first.receipt);
  expect(afterRestart.offers).toEqual(first.offers);
  expect(replay.receipt).toEqual(first.receipt);
  expect(replay.offers).toEqual(first.offers);
  expect(pane.writes).toEqual([]);
  expect(pane.keys).toEqual([]);
});
