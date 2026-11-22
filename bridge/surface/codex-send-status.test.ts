// Independent owner oracle 2026-11-14: normal Send on the captured Main/status footer
// submits without a manual recovery key. Bun tests use target_proof, not @req metadata.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { muxAck, muxOk } from "../mux/types.ts";
import { profileFor } from "../../web/src/lib/surface/profile.ts";
import { KeyGate } from "./key-gate.ts";
import { RowRing, SendProtocol, SessionLocks } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

const fixtureDir = join(import.meta.dirname, "../../web/src/fixtures");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function replay(raw: string) {
  const dir = mkdtempSync(join(tmpdir(), "collie-codex-send-status-"));
  dirs.push(dir);
  const rows = raw.trimEnd().split("\n");
  const prompt = rows.findIndex((row) => row.includes("Ask Codex to do anything"));
  let box = "";
  let revision = 1;
  let clock = 1_000_000;
  const now = () => clock;
  const keysSeen: string[] = [];
  const writes: string[] = [];
  const submitted: string[] = [];
  const running = raw.includes("Working");
  const render = () => {
    if (prompt < 0) return raw;
    const drawn = [...rows];
    if (box !== "") drawn[prompt] = `› ${box}`;
    const transcript = submitted.map((text) => running ? `  ↳ ${text}` : `› ${text}`);
    return [...transcript, ...drawn].join("\n");
  };
  const write = async (_paneId: string, text: string) => {
    writes.push(text);
    box += text;
    revision++;
    return muxAck();
  };
  const writeKeys = async (_paneId: string, keys: readonly string[]) => {
    for (const key of keys) {
      keysSeen.push(key);
      if (key === "Backspace") box = [...box].slice(0, -1).join("");
      if (key === "ctrl+u" || key === "ctrl+k") box = "";
      if ((key === "Enter" || key === "Tab") && box !== "") {
        submitted.push(box);
        box = "";
      }
      revision++;
    }
    return muxAck();
  };
  const pane = {
    readGrid: async (paneId: string) => muxOk({ paneId, text: render(), revision, truncated: false }),
    typeText: write,
    pasteText: write,
    writeKeys,
  };
  const protocol = new SendProtocol({
    mux: pane,
    gate: new KeyGate(pane, now),
    store: new RequestStore(join(dir, "sends"), now),
    locks: new SessionLocks(),
    ring: new RowRing(),
    profile: async (harness: string) => profileFor(harness, "0.169.0", { log: () => undefined }),
    generation: () => "capture-generation",
    now,
    sleep: async (ms: number) => { clock += ms; },
  });
  const send = () => protocol.handle(
    { id: "captured-send-0001", text: "send this message from the phone", mode: "send", fromPhone: true },
    { session: "codex-capture", paneId: "%1", harness: "codex" },
  );
  return { send, submitted, keysSeen, writes };
}

describe("SEND_2 ordinary phone Send on real Codex status tails", () => {
  for (const [folder, name] of [["surface", "codex-send-main-idle.ansi"], ["surface", "codex-send-wrapped-running.ansi"], ["panes", "codex--v0169-working--w120.txt"]] as const) {
    test(`${name}: one request submits with no refused result or manual recovery`, async () => {
      const pane = replay(readFileSync(join(fixtureDir, folder, name), "utf8"));
      const answer = await pane.send();
      expect(answer.receipt?.outcome).toBe("sent");
      expect(answer.offers).toEqual([]);
      expect(pane.submitted).toEqual(["send this message from the phone"]);
      expect(pane.keysSeen.filter((key) => key === "Enter" || key === "Tab")).toHaveLength(1);
      expect(pane.keysSeen).not.toContain("Escape");
    });
  }
});

describe("SEND_3 real Codex modal screens refuse before writing", () => {
  for (const name of ["codex--v0169-model-dialog--w120.txt", "codex--v0156-approval-exec-2opt.txt", "codex--v0156-approval-patch.txt"]) {
    test(`${name}: no message or submit key reaches the dialog`, async () => {
      const pane = replay(readFileSync(join(fixtureDir, "panes", name), "utf8"));
      const answer = await pane.send();
      expect(answer.receipt?.outcome).toBe("refused");
      expect(pane.writes).toEqual([]);
      expect(pane.keysSeen).toEqual([]);
      expect(pane.submitted).toEqual([]);
    });
  }
});
