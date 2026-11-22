import { readFileSync } from "node:fs";
import { join } from "node:path";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { profileFor } from "../../web/src/lib/surface/profile.ts";
import { HoldStore } from "./holds.ts";
import { KeyGate } from "./key-gate.ts";
import { RowRing, SendProtocol, SessionLocks, type SendRequest } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

export function capture(name: string): string {
  return readFileSync(join(import.meta.dir, "../../web/src/fixtures/panes", name), "utf8").replace(/\r/gu, "");
}

/** Every write is visible to the test, including which screen reads preceded it. */
export class ReviewPane {
  reads = 0;
  writes: { text: string; afterReads: number }[] = [];
  keys: string[] = [];
  constructor(readonly screen: (read: number) => string) {}

  readGrid = (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    this.reads++;
    return Promise.resolve(muxOk({ paneId, text: this.screen(this.reads), truncated: false, revision: this.reads }));
  };
  typeText = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    this.writes.push({ text, afterReads: this.reads });
    return Promise.resolve(muxAck());
  };
  pasteText = this.typeText;
  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
    this.keys.push(...keys);
    return Promise.resolve(muxAck());
  };
}

export function reviewRig(dir: string, pane: ReviewPane, harness: string, version: string) {
  const clock = { now: 1_000_000 };
  const now = (): number => clock.now;
  const holds = new HoldStore(join(dir, "held"), now);
  const protocol = new SendProtocol({
    mux: { readGrid: pane.readGrid, typeText: pane.typeText, pasteText: pane.pasteText },
    gate: new KeyGate(pane, now),
    store: new RequestStore(join(dir, "sends"), now),
    locks: new SessionLocks(),
    ring: new RowRing(),
    holds,
    profile: () => Promise.resolve(profileFor(harness, version, { log: () => undefined })),
    generation: () => "gen-review-1",
    now,
    sleep: (ms: number) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
  let serial = 0;
  const send = (text: string, over: Partial<SendRequest> = {}) =>
    protocol.handle({ id: `review-fix-${String(++serial).padStart(6, "0")}`, text, mode: "send", fromPhone: true, ...over }, { session: "main", paneId: "%1", harness });
  return { send, holds };
}
