// Oracle: finding 6 in collie-1290-r2-brief.md, finding 4 in collie-1290-r3-brief.md,
// and the keys printed on the real Claude Code screen.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AuditLog } from "../audit.ts";
import { loadConfig } from "../config.ts";
import type { MuxAdapter } from "../mux/types.ts";
import { keysPane, sendRoute, type SendRouteRuntime } from "../server.ts";
import { invariantRig, LogPane } from "./invariants-rig.ts";

const PANE = "%1";
const CAPTURES = [
  "claude--v2327-effort-dialog.txt",
  "claude--v2327-effort-dialog-default.txt",
  "claude--v2327-effort-dialog-default.ansi.txt",
];
const SGR = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;]*m`, "gu");
const audit = new AuditLog(() => undefined);
const cfg = loadConfig({ COLLIE_MUX: "herdr" }, () => false, () => []);

describe.each(CAPTURES)("@req:R2-EFFORT-DEFAULT @oracle:requirement %s", (name) => {
  const raw = readFileSync(join(import.meta.dir, "../../web/src/fixtures/panes", name), "utf8");
  const draw = { kind: "fixed", text: raw, echoes: false } as const;

  test("a phone Send while Effort is open refuses without typing or pressing a key", async () => {
    const rig = invariantRig({ harness: "claude", version: "2.1.327", draw });
    try {
      const runtime: SendRouteRuntime = {
        send: rig.protocol,
        name: "main",
        herdr: {},
        engine: {
          current: () => ({ agents: [{ paneId: PANE, agent: "claude" }] }),
          noteInput: () => undefined,
          pokeNow: () => undefined,
        },
      };
      const response = await sendRoute(runtime, {
        id: "effort-2327-phone-send",
        pane: PANE,
        text: "please check the parser tests",
      }, { audit, device: "phone", redact: false, acceptEncoding: null });
      expect(await response.json()).toMatchObject({ receipt: { outcome: "refused", keys: [] } });
      expect(rig.pane.log).toEqual([]);
    } finally {
      rig.dispose();
    }
  });

  test.each(["Left", "Right", "s", "Enter", "Escape"])("the caption-bound key route forwards %s", async (key) => {
    // The phone sends visible text as its binding. The bridge reads the original, styled grid.
    const rows = raw.replace(SGR, "").split("\n");
    const title = rows.findIndex((row) => row.trim() === "Effort");
    const footer = rows.findIndex((row) => row.includes("←/→ to adjust"));
    expect(title).toBeGreaterThan(0);
    expect(footer).toBeGreaterThan(title);
    // The phone binds the rule above the caption through the key footer, excluding the composer.
    const expectedPrompt = rows.slice(title - 1, footer + 1).join("\n");
    const request = new Request("http://localhost/api/pane/%251/keys", {
      method: "POST",
      body: JSON.stringify({ keys: [key], expected_prompt: expectedPrompt }),
    });
    const pane = new LogPane(draw);
    const stub: Partial<MuxAdapter> = { mux: "herdr", readGrid: pane.readGrid, writeKeys: pane.writeKeys };
    // SAFETY: the caption-bound keys handler reaches only these three adapter members.
    const response = await keysPane(stub as MuxAdapter, cfg, PANE, request, audit, "phone", "main");
    expect(response.status).toBe(200);
    expect(pane.log).toEqual([{ kind: "keys", value: key }]);
  });
});
