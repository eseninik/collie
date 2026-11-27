import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { forgetHostVersions } from "@/hooks/use-host-version";
import { resetPinsForTests } from "@/lib/loaders";
import { __forgetSendAgainMemory } from "@/lib/send-again";
import { clearStatus } from "@/lib/status";
import type { Surface } from "@/lib/surface/surface";
import type { AgentView } from "@/lib/types";
import { claude21332, claudeFrames } from "@/test/claude-21332";
import { readClaudeCapture } from "@/test/claude-21332-captures";
import { fixtureAgents, paneTextWithDraft, recordedSends, sendAnswer, sendHandler } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";
import { idleFor, readScreen, rowsOf } from "@/test/surface-corpus";
import { AgentChat } from "./agent-chat";

vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => true,
  useLive: () => true,
}));

const CAPTION = "Collie cannot read this screen. You can.";
const OVERRIDE_HINT = "Your message goes past this screen…";
const UNKNOWN: Surface = { revision: 1, turn: "idle", modal: "unreadable", composer: "unknown" };
const DIRECT_AGENTS = ["claude", "codex"] as const;
const DIALOGS = [
  ["claude", "claude-lab--menu-status-screen--w82.txt"],
  ["codex", "codex--ask-notes-focused.txt"],
] as const;

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

beforeEach(() => {
  clearStatus();
  forgetHostVersions();
  resetPinsForTests();
  __forgetSendAgainMemory();
  localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ paneView: "chat", showToolCalls: true }));
});

function mount(harness: (typeof DIRECT_AGENTS)[number], text: string, surface: Surface, status: AgentView["status"]) {
  let updatePane: (text: string, surface: Surface) => void = () => undefined;
  const paneId = fixtureAgents[0]!.paneId;
  let pane = { paneId, text, truncated: false, revision: surface.revision };
  server.use(http.get(/\/api\/pane\/[^/]+$/, () => HttpResponse.json(pane)));
  function Harness() {
    const [reading, setReading] = useState({ text, surface });
    updatePane = (nextText, nextSurface) => {
      pane = { ...pane, text: nextText, revision: nextSurface.revision };
      act(() => setReading({ text: nextText, surface: nextSurface }));
    };
    const agent: AgentView = { ...fixtureAgents[0]!, agent: harness, hasSession: true, surface: reading.surface, status };
    return withHeaderHost(
      <AgentChat paneId={paneId} agent={agent} agents={[agent]} shellPanes={[]} tabs={[]} text={reading.text} revision={reading.surface.revision} onBack={vi.fn()} onSelect={vi.fn()} />,
    );
  }
  render(<RouterProvider router={createMemoryRouter([{ path: "/", element: <Harness /> }])} />);
  return { show: (nextText: string, nextSurface: Surface) => updatePane(nextText, nextSurface) };
}

function expectNoOverride() {
  expect(screen.queryAllByRole("button", { name: "Send anyway" })).toHaveLength(0);
  expect(screen.queryByPlaceholderText(OVERRIDE_HINT)).toBeNull();
}

describe("@req:REQ-DIRECT @oracle:requirement AgentChat on ordinary Claude Code 2.1.332 screens", () => {
  it.each(claudeFrames)("sends a normal phone message on %s without an unread card or override", async (frame) => {
    const text = claude21332(frame);
    const { surface } = readScreen(rowsOf(text), "claude", idleFor("claude"));
    server.use(...sendHandler((request) => sendAnswer(request.id, "sent", undefined, { surface, queued: true })));
    mount("claude", text, surface, "working");

    const user = userEvent.setup();
    const box = await screen.findByPlaceholderText("Type a reply…");
    const words = "Check the example from my phone.";
    expect(screen.queryByText(CAPTION)).toBeNull();
    expectNoOverride();
    await user.type(box, words);
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(recordedSends()).toHaveLength(1));
    expect(recordedSends()[0]).toMatchObject({ text: words, mode: "send" });
    expect(recordedSends()[0]?.override).toBeUndefined();
    await waitFor(() => expect(box).toHaveValue(""));
    expect(screen.queryByText(CAPTION)).toBeNull();
    expectNoOverride();
  });

  // The reported sends returned these receipts even though the returned surface was readable.
  it.each([
    ["queued message", "modal_cue", "screen-queued.txt"],
    ["running Bash", "mismatch", "screen-1.txt"],
  ] as const)("keeps %s readable after a %s send receipt and a later read @req:UNREAD-REWORK-READABLE @oracle:requirement", async (frame, reason, capture) => {
    const text = claude21332(frame);
    const { surface: read } = readScreen(rowsOf(text), "claude", idleFor("claude"));
    const surface = { ...read, revision: 0 };
    server.use(...sendHandler((request) => sendAnswer(request.id, "typed_not_submitted", reason, {
      offers: ["keys"],
      surface,
    })));
    const mounted = mount("claude", text, surface, "working");

    const user = userEvent.setup();
    const box = await screen.findByPlaceholderText("Type a reply…");
    const send = screen.getByRole("button", { name: "Send" });
    const words = "Check the example from my phone.";
    await user.type(box, words);
    await user.click(send);
    await waitFor(() => expect(recordedSends()).toHaveLength(1));
    // A failed submit restores the draft when the response has been handled.
    await waitFor(() => expect(box).toHaveValue(words));
    await waitFor(() => expect(send).toBeEnabled());

    expect(recordedSends()[0]).toMatchObject({ text: words, mode: "send" });
    expect(recordedSends()[0]?.override).toBeUndefined();
    expect(screen.queryByText(CAPTION)).toBeNull();
    expect(screen.getByRole("button", { name: "Keys" })).toBeEnabled();
    expectNoOverride();
    const refusal = document.querySelector('[data-slot="composer-refusal"]');
    expect(refusal).toBeVisible();
    expect(refusal).toHaveTextContent("Your message was typed into the pane but not sent. Check the pane before sending it again.");

    const captured = readClaudeCapture(capture);
    const later = readScreen(rowsOf(captured), "claude", idleFor("claude")).surface;
    expect(later).toMatchObject({ turn: "running", modal: "none", composer: "empty" });
    mounted.show(captured, { ...later, revision: surface.revision + 1 });
    expect(screen.queryByText(CAPTION)).toBeNull();
    expectNoOverride();
  });
});

describe("@req:REQ-OVERRIDE @oracle:requirement unread-dialog controls on direct profiles", () => {
  it.each(DIALOGS)("%s keeps Keys and Report on a detected unread dialog without a send override", async (harness, fixture) => {
    const text = readFileSync(join(import.meta.dirname, "..", "fixtures", "panes", fixture), "utf8");
    const { surface } = readScreen(rowsOf(text), harness, idleFor(harness));
    mount(harness, text, surface, "blocked");

    expect(await screen.findByText(CAPTION)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keys" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Report a problem" })).toBeEnabled();
    expectNoOverride();
  });

  it.each(DIRECT_AGENTS)("%s keeps Keys on a send refusal without a send override", async (harness) => {
    server.use(...sendHandler((request) => sendAnswer(request.id, "refused", "not_free", {
      offers: ["keys"],
      rowsHash: "ab12cd",
      surface: UNKNOWN,
    })));
    localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ paneView: "raw" }));
    mount(harness, paneTextWithDraft("Pane output before the refusal"), UNKNOWN, "idle");

    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText("Type a reply…"), "Continue when you are ready.");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(CAPTION)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keys" })).toHaveAttribute("aria-expanded", "true");
    expectNoOverride();
    expect(recordedSends()).toHaveLength(1);
    expect(recordedSends()[0]?.override).toBeUndefined();
  });
});

describe("@req:REQ-KEEPS @oracle:requirement a real unread dialog still keeps its Keys", () => {
  it("Claude Code's status screen keeps the card and its declared Esc key", async () => {
    const text = readFileSync(join(import.meta.dirname, "..", "fixtures", "panes", DIALOGS[0][1]), "utf8");
    const { surface } = readScreen(rowsOf(text), "claude", idleFor("claude"));
    mount("claude", text, surface, "blocked");

    const card = await screen.findByRole("group", { name: CAPTION });
    expect(within(card).getByText(CAPTION)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Esc" })).toBeInTheDocument();
    expect(recordedSends()).toHaveLength(0);
  });
});
