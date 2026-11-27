import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { forgetHostVersions } from "@/hooks/use-host-version";
import { resetPinsForTests } from "@/lib/loaders";
import { clearStatus, useStatus } from "@/lib/status";
import type { AgentView } from "@/lib/types";
import { fixtureAgents, FIXTURE_CHAT_GEN, FIXTURE_SEQ_BASE, fixtureTranscript, paneTextWithDraft, recordedSends, sendAnswer, sendHandler } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/msw";
import { AgentChat } from "./agent-chat";

vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => true,
  useLive: () => true,
}));

const RETURNED = { requestId: "req-back-00001", state: "returned", text: "Check the sample output." } as const;

// Exercise the returned-card action for a Claude pane in the view that still offers it.
vi.mock("@/lib/surface/profiles/direct-send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/surface/profiles/direct-send")>()),
  directSendProfile: () => false,
}));

function StatusLine() {
  const status = useStatus();
  return <div role="status" aria-label="Send status">{status?.text ?? ""}</div>;
}

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  forgetHostVersions();
  resetPinsForTests();
  localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ paneView: "chat", showToolCalls: true }));
});

function mountReturned(answer: Parameters<typeof sendHandler>[0]) {
  const agent: AgentView = { ...fixtureAgents[0]!, agent: "claude", hasSession: true, sendProtocol: true };
  server.use(
    http.get(/\/api\/pane\/[^/]+\/chat/, () => HttpResponse.json({
      paneId: agent.paneId, available: true, page: "live", gen: FIXTURE_CHAT_GEN, rev: 1,
      head: FIXTURE_SEQ_BASE + fixtureTranscript.length - 1, oldest: FIXTURE_SEQ_BASE, hasOlder: false,
      upserts: fixtureTranscript.map((entry, index) => Object.assign({}, entry, { seq: FIXTURE_SEQ_BASE + index })),
      queuedSends: [RETURNED],
    })),
    ...sendHandler(answer),
  );
  const element = withHeaderHost(
    <>
      <StatusLine />
      <AgentChat paneId={agent.paneId} agent={agent} agents={[agent]} shellPanes={[]} tabs={[]} text={paneTextWithDraft(RETURNED.text)} onBack={vi.fn()} onSelect={vi.fn()} />
    </>,
  );
  render(<RouterProvider router={createMemoryRouter([{ path: "/", element }])} />);
}

it("@req:REQ-RETURNED-SUBMIT @oracle:requirement a refused Submit of a returned Claude line gives the status without override instructions", async () => {
  mountReturned((request) => sendAnswer(request.id, "refused", "unconfirmed", {
    offers: ["commit", "keys"], rowsHash: "ab12cd",
    detail: "Collie cannot read this screen. Check the pane, then tap Type here.",
  }));

  await userEvent.click(await screen.findByRole("button", { name: "Send this message from the agent's box" }));

  const status = screen.getByRole("status", { name: "Send status" });
  await waitFor(() => expect(status).toHaveTextContent("Collie cannot read this screen. Check the screen or open Keys."));
  expect(status).not.toHaveTextContent(/Send anyway|Type here/iu);
  expect(recordedSends()).toHaveLength(1);
  expect(recordedSends()[0]).toMatchObject({ mode: "submit" });
});

it("@req:REQ-RETURNED-TYPED @oracle:requirement a stopped Submit of a returned Claude line names Submit and Discard", async () => {
  mountReturned((request) => sendAnswer(request.id, "typed_not_submitted", "changed", {
    offers: ["submit", "discard", "keys"], rowsHash: "ab12cd",
  }));

  const submit = await screen.findByRole("button", { name: "Send this message from the agent's box" });
  const discard = screen.getByRole("button", { name: "Discard this message from the agent's box" });
  expect(discard).toBeVisible();
  await userEvent.click(submit);

  const status = screen.getByRole("status", { name: "Send status" });
  await waitFor(() => expect(status).toHaveTextContent("Submit it or discard it."));
  expect(status).not.toHaveTextContent(/sending it again/iu);
  expect(submit).toBeEnabled();
  expect(discard).toBeEnabled();
  expect(recordedSends()).toHaveLength(1);
  expect(recordedSends()[0]).toMatchObject({ mode: "submit" });
});
