import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

// Like the existing AgentChat send tests, pin the pane live without polling the fake bridge.
vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => true,
  useLive: () => true,
}));

import { forgetHostVersions } from "@/hooks/use-host-version";
import { resetPinsForTests } from "@/lib/loaders";
import { __forgetSendAgainMemory } from "@/lib/send-again";
import { clearStatus } from "@/lib/status";
import type { Surface } from "@/lib/surface/surface";
import type { AgentView, ChatWindowBody, DeviceAuth } from "@/lib/types";
import { fixtureAgents, paneTextWithDraft, recordedSends, sendAnswer, sendHandler } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";
import { AgentChat } from "./agent-chat";

// Oracle: the owner's direct-send requirement, supplied in the 1.29.0 port assignment.
// Ordinary Claude/Codex sends have no unconfirmed-send card or recovery actions. Sign-in codes
// and agent views retain their separate upstream contracts. The author has not read product code.
const FREE: Surface = { revision: 1, turn: "idle", modal: "none", composer: "empty" };

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

function mount(harness: "claude" | "codex", device?: DeviceAuth) {
  const agent: AgentView = { ...fixtureAgents[0]!, agent: harness, hasSession: true, surface: FREE };
  const element = withHeaderHost(
    <AgentChat device={device} paneId={agent.paneId} agent={agent} agents={[agent]} shellPanes={[]} tabs={[]} text={paneTextWithDraft("recent pane output")} onBack={vi.fn()} onSelect={vi.fn()} />,
  );
  render(<RouterProvider router={createMemoryRouter([{ path: "/", element }])} />);
}

describe("@req:PORT-DIRECT-UNKNOWN @oracle:requirement AgentChat ordinary direct sends", () => {
  it.each(["claude", "codex"] as const)("%s keeps an unknown receipt free of the cannot-tell card and its actions", async (harness) => {
    server.use(...sendHandler((request) => sendAnswer(request.id, "unknown", "no_evidence", { offers: ["keys"], surface: FREE })));
    const user = userEvent.setup();
    mount(harness);
    const box = screen.getByRole("textbox");
    const words = "run the sample check";
    await user.type(box, words);
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(recordedSends()).toHaveLength(1));
    expect(recordedSends()[0]).toMatchObject({ text: words, mode: "send" });
    expect(recordedSends()[0]?.secret).toBeUndefined();
    // As in the upstream unknown-send tests, the restored draft proves the answer has landed.
    await waitFor(() => expect(box).toHaveValue(words));
    expect(screen.queryByRole("group", { name: /Collie (cannot tell|is waiting)/u })).toBeNull();
    expect(screen.queryByText("Collie cannot tell if this arrived. Look at the screen.")).toBeNull();
    for (const name of ["It arrived", "Send again", "Enter it again", "Submit", "Discard", "Send now"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.queryByText("Draft in terminal", { exact: true })).toBeNull();
  });
});

describe("AgentChat — Send now on the waiting card", () => {
  it.each(["claude", "codex"] as const)("draws no waiting card and no Send now on %s, even with declared keys", async (name) => {
    const body: ChatWindowBody & { paneId: string; available: true } = {
      paneId: "w1:p1",
      available: true,
      page: "live",
      gen: 7,
      rev: 1,
      head: 1,
      oldest: 1,
      hasOlder: false,
      upserts: [],
      queued: ["first", "second"],
      sendQueuedNow: ["ctrl+Enter"],
    };
    let served = 0;
    server.use(http.get(/\/api\/pane\/[^/]+\/chat/, () => {
      served += 1;
      return HttpResponse.json(body);
    }));
    const sent: unknown[] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.json({ ok: true });
      }),
    );
    mount(name, { enforced: true, device: "my-phone", authorized: true });
    await waitFor(() => expect(served).toBeGreaterThan(0));
    // A poll after the answer: the chat had its turn to draw the queue.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.queryByText("Waiting to send")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send now, the waiting messages" })).toBeNull();
    expect(sent).toHaveLength(0);
  });
});
