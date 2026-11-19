// Oracle: finding 3 in collie-1290-fix-brief.md. Direct phone users cannot act on hidden held cards.
// Written on the reviewed base before the fix, without opening implementation or builder notes.
import { afterEach, expect } from "bun:test";
import { DATA_PANE, dataDescribe, dataId, dataRig, dataTest, type DataRig } from "../inside/data-rig.ts";
import { HOLD_PANE_MAX } from "./holds.ts";

const rigs: DataRig[] = [];
afterEach(() => {
  for (const rig of rigs.splice(0)) rig.stop();
});

async function fullQueue(harness: string, version: string) {
  const rig = await dataRig({ harness, version });
  rigs.push(rig);
  const part = await rig.part();
  await part.event("turn.start", { turn: "review-fix-turn" });
  for (let i = 0; i < HOLD_PANE_MAX; i++) {
    const held = await rig.send(dataId(), `waiting message ${String(i)}`, { fromPhone: true });
    expect(held.receipt).toMatchObject({ outcome: "held", keys: [] });
  }
  expect(rig.holds.waiting(DATA_PANE.session, DATA_PANE.paneId)).toHaveLength(HOLD_PANE_MAX);
  return rig;
}

dataDescribe("FIX-HOLD-CAP @oracle:requirement data-road capacity refusal", () => {
  dataTest("Claude phone send after the pane cap gives an action available without held cards", async () => {
    const rig = await fullQueue("claude", "2.1.200");
    const answer = await rig.send(dataId(), "one message over the cap", { fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "busy", keys: [] });
    expect(answer.detail).not.toMatch(/cancel/iu);
    expect(answer.detail).toMatch(/wait|turn ends|turn to end/iu);
    expect(answer.receipt?.detail).toBe(answer.detail);
    expect(rig.mux.calls).toEqual([]);
    expect(rig.holds.waiting(DATA_PANE.session, DATA_PANE.paneId)).toHaveLength(HOLD_PANE_MAX);
  });

  dataTest("Muse keeps the upstream instruction to cancel a held send", async () => {
    const rig = await fullQueue("muse", "1.4.10");
    const answer = await rig.send(dataId(), "one message over the cap", { fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "busy", keys: [] });
    expect(answer.detail).toMatch(/cancel/iu);
    expect(answer.detail).toMatch(/holds|held/iu);
    expect(rig.mux.calls).toEqual([]);
  });
});
