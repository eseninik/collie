import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Page } from "@playwright/test";

import type { AgentView, PaneChatResponse, SnapshotResponse, TranscriptEntry } from "@/lib/types";
import { FIXTURE_CHAT_GEN, FIXTURE_SEQ_BASE, fixtureAgents, fixtureSnapshot } from "@/test/handlers";
import { installApiStub, installPaneWorld, paneCapture, pinLocale } from "./api";

export type ChatHarness = "claude" | "codex";

export function comparisonTranscript(harness: ChatHarness) {
  const folder = resolve(process.env.CODEX_CHAT_MATERIALIZED ?? "../../codex-reports/codex-chat/materialized");
  // SAFETY: this file is produced by our Bun test materializer immediately before the preview starts.
  return JSON.parse(readFileSync(resolve(folder, `${harness}.json`), "utf8")) as TranscriptEntry[];
}

export async function openComparisonChat(page: Page, harness: ChatHarness) {
  await page.addInitScript(() => localStorage.setItem("collie:theme:v1", "dark"));
  await page.emulateMedia({ colorScheme: "dark" });
  await pinLocale(page, "en");
  await installApiStub(page);
  const template = fixtureAgents.find((candidate) => candidate.agent === harness);
  if (template === undefined) throw new Error(`no fixture agent for ${harness}`);
  const agent: AgentView = {
    ...template,
    agent: harness,
    paneLabel: `${harness} comparison`,
    status: "working",
    hasSession: true,
    sendProtocol: true,
    canSteer: true,
    model: harness === "codex" ? "gpt-6-sol" : "claude-opus-5-5",
    effort: "medium",
    // The 7d caption is a limit window (ModelTag public tests), not a session-age field.
    usage: { limits: [{ window: "7d", used: 80 }] },
  };
  const entries = comparisonTranscript(harness);
  const snapshot: SnapshotResponse = { ...fixtureSnapshot, agents: [agent], shellPanes: [] };
  const chat: PaneChatResponse = {
    paneId: agent.paneId,
    available: true,
    page: "live",
    gen: FIXTURE_CHAT_GEN,
    rev: 1,
    head: FIXTURE_SEQ_BASE + entries.length - 1,
    oldest: FIXTURE_SEQ_BASE,
    hasOlder: false,
    upserts: entries.map((entry, index) => ({ ...entry, seq: FIXTURE_SEQ_BASE + index })),
  };
  await installPaneWorld(page, {
    paneId: agent.paneId,
    snapshot,
    chat,
    screens: {
      captured: paneCapture(harness === "codex"
        ? "codex--v0169-working-queued--w80"
        : "claude--v2301-working-quiet--w100"),
    },
    start: "captured",
  });
  await page.goto(`/pane/${encodeURIComponent(agent.paneId)}`);
  return agent;
}
