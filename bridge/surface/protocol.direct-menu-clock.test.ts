// Requirement source: I7 in invariants.mutation.test.ts; confirmed replay seed 403990326.
// Authored independently on 8277bd60b without reading production implementation or builder notes.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { invariantRig, personTap, type RigOptions } from "./invariants-rig.ts";

const FIXTURE = "claude--v2301-usage-panel-over-box--w82.txt";
const RAW = readFileSync(join(import.meta.dir, "../../web/src/fixtures/panes", FIXTURE), "utf8");
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/gu;
const plain = (row: string): string => row.replace(ANSI, "");
// The same public profile pin as the existing seeded invariant suite.
const PIN: RigOptions["pinVersions"] = [{ range: "2.1.0 - 2.1.296", low: "2.1.0", high: "2.1.296", status: "verified", verifiedThrough: "2.1.296", verifiedOn: "2026-10-12" }];

/** All ten possible row positions of the existing right-clock mutation; no random seed is needed. */
function clockAt(offset: number) {
  const rows = RAW.replace(/\n+$/u, "").split("\n");
  const lastFilled = rows.reduce((last, row, i) => plain(row).trim() === "" ? last : i, 0);
  const at = Math.max(0, lastFilled - offset);
  const row = rows[at] ?? "";
  const cr = row.endsWith("\r") ? "\r" : "";
  const body = row.slice(0, row.length - cr.length);
  const width = Math.max(80, plain(body).length + 4);
  rows[at] = `${body}${" ".repeat(Math.max(1, width - plain(body).length - 8))}12:34:56${cr}`;
  return { screen: rows.join("\n"), row: at };
}

describe("@req:FIX-DIRECT-MENU-GUARD @oracle:requirement I7: a phone's first send never writes onto the open Usage panel", () => {
  for (let offset = 0; offset < 10; offset++) {
    test(`a right-clock ${String(offset)} rows above the last filled row leaves the panel protected`, async () => {
      const changed = clockAt(offset);
      // The fixture still names the open panel's cancel action after the clock mutation.
      expect(plain(changed.screen)).toContain("Esc to cancel");
      const rig = invariantRig({
        harness: "claude",
        version: "2.1.301",
        pinVersions: PIN,
        draw: { kind: "fixed", text: changed.screen, echoes: false },
      });
      try {
        const result = await personTap(rig, "please carry on with the parser fix");
        if (result.writes.length > 0) {
          console.log("DIRECT_MENU_GUARD_DIAGNOSTIC", JSON.stringify({
            fixture: FIXTURE,
            offset,
            row: changed.row,
            surface: result.answer.surface ?? null,
            receipt: result.answer.receipt ?? null,
            writes: result.writes,
          }));
        }
        // The oracle is the terminal write log, never an internal state or refusal reason.
        expect(result.writes).toEqual([]);
      } finally {
        rig.dispose();
      }
    });
  }
});
