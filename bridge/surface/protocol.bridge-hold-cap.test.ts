// Oracle: Collie 1.29.0 review round 2, finding 5.
import { afterEach, expect } from "bun:test";
import { DATA_PANE, dataDescribe, dataId, dataRig, dataTest, type DataRig } from "../inside/data-rig.ts";
import { HOLD_BRIDGE_MAX, HOLD_PANE_MAX } from "./holds.ts";

const rigs: DataRig[] = [];
afterEach(() => {
  for (const rig of rigs.splice(0)) rig.stop();
});

dataDescribe("@req:R2-BRIDGE-HOLD-CAP @oracle:requirement bridge-wide send hold limit", () => {
  for (const [harness, version, direct] of [
    ["claude", "2.1.200", true],
    ["codex", "0.169.0", true],
    ["muse", "1.4.10", false],
  ] as const) {
    dataTest(`${harness} phone send at the bridge cap`, async () => {
      const rig = await dataRig({ harness, version });
      rigs.push(rig);
      const part = await rig.part();
      await part.event("turn.start", { turn: "bridge-cap-turn" });

      // Fill other panes and leave this pane empty, so only the shared limit can refuse the send.
      for (let index = 0; index < HOLD_BRIDGE_MAX; index++) {
        const pane = Math.floor(index / HOLD_PANE_MAX) + 2;
        rig.holds.add({
          id: dataId(),
          session: DATA_PANE.session,
          paneId: `w1:p${String(pane)}`,
          harness,
          mode: "send",
          text: "another pane's held message",
          revision: 0,
          command: false,
          cause: "turn_running",
        });
      }
      expect(rig.holds.waitingCount()).toBe(HOLD_BRIDGE_MAX);
      expect(rig.holds.waiting(DATA_PANE.session, DATA_PANE.paneId)).toEqual([]);
      const answer = await rig.send(dataId(), "one message over the bridge cap");
      expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "busy", keys: [] });
      expect(answer.detail).toBe(answer.receipt?.detail);
      expect(rig.holds.waitingCount()).toBe(HOLD_BRIDGE_MAX);
      expect(rig.holds.waiting(DATA_PANE.session, DATA_PANE.paneId)).toEqual([]);
      expect(rig.mux.calls).toEqual([]);

      // Free one slot to check that this phone send could have been held.
      const [held] = rig.holds.waiting(DATA_PANE.session, "w1:p2");
      expect(held).toBeDefined();
      expect(rig.holds.remove(held!.id)).toBe(true);
      const belowCap = await rig.send(dataId(), "one message below the bridge cap");
      expect(belowCap.receipt).toMatchObject({ outcome: "held", keys: [] });

      if (direct) {
        expect(answer.detail).toMatch(/wait|turn ends|turn to end/iu);
        expect(answer.detail).not.toMatch(/cancel/iu);
      } else {
        expect(answer.detail).toMatch(/cancel one/iu);
      }
    });
  }
});
