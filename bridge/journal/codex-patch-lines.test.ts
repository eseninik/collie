// An apply_patch body has no file headers, so a removed `-- comment` or `---` and an added `++i` are
// changed lines, never a preamble to skip (review finding of the Codex chat task).

import { describe, expect, test } from "bun:test";
import { codexPatchCalls } from "./codex-tools.ts";

describe("codexPatchCalls keeps lines that look like diff headers", () => {
  test("a removed `-- comment` and `---`, an added `++i`, are all in the card and its counts", () => {
    const patch = ["*** Begin Patch", "*** Update File: a.sql", "@@", "--- old comment", "----", " keep", "+-- new comment", "+++i;", "*** End Patch"].join("\n");
    const [call] = codexPatchCalls(patch);
    expect(call).toMatchObject({ kind: "edit", path: "a.sql", added: 2, removed: 2 });
    expect(call?.kind === "edit" ? call.diff?.[0]?.lines : undefined).toEqual(["--- old comment", "----", " keep", "+-- new comment", "+++i;"]);
  });
});
