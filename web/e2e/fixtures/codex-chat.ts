import { readFileSync } from "node:fs";

import type { Page } from "@playwright/test";

import { parseCodexTranscript } from "../../../bridge/journal/codex";
import { parseClaudeTranscript } from "../../../bridge/journal/claude";
import type { AgentView, PaneChatResponse, SnapshotResponse } from "@/lib/types";
import { FIXTURE_CHAT_GEN, FIXTURE_SEQ_BASE, fixtureAgents, fixtureSnapshot } from "@/test/handlers";
import { installApiStub, installPaneWorld, paneCapture, pinLocale } from "./api";

export type ChatHarness = "claude" | "codex";

export function comparisonTranscript(harness: ChatHarness) {
  const raw = readFileSync(new URL(`../../../bridge/journal/fixtures/codex-chat/${harness}-reference.jsonl`, import.meta.url), "utf8");
  return harness === "codex" ? parseCodexTranscript(raw) : parseClaudeTranscript(raw);
}

export async function openComparisonChat(page: Page, harness: ChatHarness) {
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
