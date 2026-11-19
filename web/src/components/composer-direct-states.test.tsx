import { createRef, useState, type ComponentProps } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";

import type { ChatMessageListHandle } from "@/components/ui/chat/chat-message-list";
import type { ChatFeed } from "@/hooks/use-chat-window";
import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { EMPTY_CHAT_WINDOW, type ChatWindow } from "@/lib/chat-window";
import { __resetPending } from "@/lib/durable-pending";
import { markLive, resetLiveness } from "@/lib/liveness";
import { __forgetSendAgainMemory } from "@/lib/send-again";
import { __forgetSendIntentMemory } from "@/lib/send-intent";
import { clearStatus } from "@/lib/status";
import { recordedSends, sendAnswer, sendHandler } from "@/test/handlers";
import { server } from "@/test/setup";
import type { CannotTellFacts } from "./cannot-tell-card";
import { CardDock } from "./card-dock";
import { Composer, type ComposerHandle } from "./composer";
import { CrewProvider } from "./crew-provider";
import { SessionStream } from "./session-stream";

// Oracle: fix brief, finding 7; Claude/Codex retain the owner's direct-send UI.
// Written from the requirement and existing tests, without reading production implementation.
const ADDRESS = "w1:p1";
const WORDS = "check the phone layout";
const FREE = { revision: 1, turn: "idle", modal: "none", composer: "empty" } as const;
const RUNNING = { ...FREE, turn: "running" } as const;
const STATES = ["held", "queued", "returned", "unconfirmed", "cannotTell", "known-refusal retry"] as const;
type State = typeof STATES[number];

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  resetLiveness();
  markLive(ADDRESS);
  sessionStorage.clear();
  __forgetSendAgainMemory();
  __forgetSendIntentMemory();
  __resetPending();
});
afterEach(() => __resetPending());

function mount(agent: "claude" | "codex", state: State) {
  const now = Date.now();
  const held: ComponentProps<typeof Composer>["held"] = state === "held" ? [
    { requestId: "direct-held-0001", mode: "send", text: WORDS, heldAt: now, expiresAt: now + 60_000, state: "held", heldLong: true, cause: "turn_running" },
    { requestId: "direct-typed-0001", mode: "send", text: WORDS, heldAt: now, expiresAt: now + 60_000, state: "ended", outcome: "typed_not_submitted", reason: "changed" },
  ] : [];
  const window: Partial<ChatWindow> = state === "queued"
    ? { queued: [WORDS], sendQueuedNow: ["ctrl+Enter"], queuedSends: [{ requestId: "direct-queue-0001", state: "queued", text: WORDS }] }
    : state === "returned" || state === "unconfirmed"
      ? { queuedSends: [{ requestId: "direct-return-0001", state, text: WORDS }] }
      : {};
  const feed: ChatFeed = {
    window: { ...EMPTY_CHAT_WINDOW, status: { kind: "live" }, ...window },
    loadOlder: vi.fn(), loadingOlder: false, asked: 0, answered: 0, tried: false,
  };
  function Harness() {
    const handle = createRef<ComposerHandle>();
    const [facts, setFacts] = useState<CannotTellFacts | null>(null);
    return <CrewProvider servers={undefined}>
      <SessionStream feed={feed} address={ADDRESS} working showToolCalls showCompactions={false} fontSize={14} listRef={createRef<ChatMessageListHandle>()} agent={agent} onSendQueuedNow={vi.fn(async () => true)} onReturned={vi.fn(async () => true)} />
      <CardDock blocks={[]} cannotTell={facts === null ? null : {
        facts, lines: splitLines(parseAnsi("Working on the request.")), wrap: true, ring: 0,
        onArrived: () => handle.current?.markArrived() ?? Promise.resolve("failed"),
        onClose: () => handle.current?.closeCannotTell(), onAgain: () => handle.current?.answerAgain(),
      }} />
      <Composer ref={handle} paneId={ADDRESS} agent={agent} isShell={false} gone={false} readOnly={false}
        surface={state === "held" || state === "queued" ? RUNNING : FREE} text="pane output"
        terminalDraft="existing terminal draft" rawTerminalDraft="existing terminal draft" held={held}
        prefs={{ wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false }}
        display={{ open: false, onToggle: vi.fn() }} onSent={vi.fn()} onCannotTell={setFacts} />
    </CrewProvider>;
  }
  render(<RouterProvider router={createMemoryRouter([{ path: "/", element: <Harness /> }])} />);
}

function expectNoRecoveryUi() {
  for (const name of [/^Submit(?: the text in the box)?$/u, /^Discard(?: the text in the box)?$/u, /^Add to it$/u, /^Replace$/u, /^Send now$/u, /^Send the queued message now, past the hold$/u]) {
    expect(screen.queryByRole("button", { name })).toBeNull();
  }
  expect(screen.queryByText(/Draft in terminal/iu)).toBeNull();
  for (const slot of ["terminal-draft-notice", "held-card", "stream-queued", "stream-queued-receipts", "stream-returned", "stream-unconfirmed", "cannot-tell-card"]) {
    expect(document.querySelector(`[data-slot='${slot}']`), slot).toBeNull();
  }
}

describe("@req:FIX-DIRECT-STATES @oracle:requirement direct-send receipt states", () => {
  it.each((["claude", "codex"] as const).flatMap((agent) => STATES.map((state) => ({ agent, state }))))(
    "$agent: $state shows no recovery controls or cards",
    async ({ agent, state }) => {
      server.use(...sendHandler((request) => {
        if (state === "cannotTell") return sendAnswer(request.id, "unknown", "no_evidence", { offers: ["keys"], surface: FREE });
        // A repeated known refusal also tests that the automatic Replace ends without recovery buttons.
        if (state === "known-refusal retry" && recordedSends().length <= 2) return sendAnswer(request.id, "refused", "draft_present", { offers: ["append", "replace", "cancel"], surface: { ...FREE, composer: "draft" } });
        return sendAnswer(request.id, "sent");
      }));
      mount(agent, state);
      expectNoRecoveryUi();
      if (state === "cannotTell" || state === "known-refusal retry") {
        const user = userEvent.setup();
        await user.type(screen.getByRole("textbox"), WORDS);
        await user.click(screen.getByRole("button", { name: "Send" }));
        await waitFor(() => expect(recordedSends()).toHaveLength(state === "cannotTell" ? 1 : 2));
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
        expectNoRecoveryUi();
        if (state === "known-refusal retry") {
          await user.click(screen.getByRole("button", { name: "Send" }));
          await waitFor(() => expect(recordedSends()).toHaveLength(3));
          expect(screen.queryByRole("button", { name: "Send it again?" })).toBeNull();
          expectNoRecoveryUi();
        }
      }
    },
  );
});
