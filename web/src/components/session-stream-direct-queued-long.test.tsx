import { act, cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";

import type { ChatMessageListHandle } from "@/components/ui/chat/chat-message-list";
import type { ChatFeed } from "@/hooks/use-chat-window";
import { EMPTY_CHAT_WINDOW, type ChatWindow } from "@/lib/chat-window";
import { __resetPending, addPending, handOverPending, setPendingState } from "@/lib/durable-pending";
import { SessionStream } from "./session-stream";

// Oracle: finding 2 and its confirmed long-wait scenario. The independent author has not read the implementation.
const ADDRESS = "w1:p1";
const WORDS = "check the phone layout after this turn";
const REQUEST = "direct-queued-long-0001";
const AT = Date.parse("2026-11-18T10:00:00.000Z");

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  // Advance the pending line's age and any scheduled expiry together, without a real twenty-second wait.
  vi.useFakeTimers();
  vi.setSystemTime(AT);
  __resetPending();
});
afterEach(() => {
  cleanup();
  __resetPending();
  vi.useRealTimers();
});

function stream(agent: "claude" | "codex" | "muse", window: Partial<ChatWindow> = {}) {
  const feed: ChatFeed = {
    window: { ...EMPTY_CHAT_WINDOW, status: { kind: "live" }, ...window },
    loadOlder: vi.fn(), loadingOlder: false, asked: 0, answered: 0, tried: false,
  };
  return <SessionStream feed={feed} address={ADDRESS} working showToolCalls showCompactions={false} fontSize={14} listRef={createRef<ChatMessageListHandle>()} agent={agent} onSendQueuedNow={vi.fn(async () => true)} onReturned={vi.fn(async () => true)} />;
}

function sentAndQueued() {
  act(() => {
    addPending(ADDRESS, { requestId: REQUEST, text: WORDS, at: AT, state: "sending", seen: new Set() });
    setPendingState(ADDRESS, REQUEST, "sent");
    handOverPending(ADDRESS, REQUEST);
  });
}

describe("@req:FIX-QUEUED-LONG @oracle:requirement a queued send waiting more than twenty seconds", () => {
  it.each([
    { agent: "claude", source: "journal" },
    { agent: "codex", source: "journal" },
    { agent: "claude", source: "receipt" },
    { agent: "codex", source: "receipt" },
  ] as const)("$agent: after 21 seconds the $source queue keeps one stream line until the user turn arrives", ({ agent, source }) => {
    const view = render(stream(agent));
    sentAndQueued();
    const queued: Partial<ChatWindow> = source === "journal"
      ? { queued: [WORDS], sendQueuedNow: ["ctrl+Enter"] }
      : { queuedSends: [{ requestId: REQUEST, state: "queued", text: WORDS }] };
    view.rerender(stream(agent, queued));
    expect(screen.getAllByText(WORDS)).toHaveLength(1);

    act(() => vi.advanceTimersByTime(21_000));
    view.rerender(stream(agent, queued));
    expect(screen.getAllByText(WORDS)).toHaveLength(1);
    expect(screen.getByText(WORDS).closest("[data-slot='stream-pending']")).not.toBeNull();
    expect(document.querySelector("[data-slot='stream-queued'], [data-slot='stream-queued-receipts']")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();

    view.rerender(stream(agent, { entries: [{
      uuid: "user-after-queue", seq: 1, requestId: REQUEST, role: "user",
      ts: new Date(AT + 21_000).toISOString(), parts: [{ kind: "text", text: WORDS }],
    }] }));
    expect(screen.getAllByText(WORDS)).toHaveLength(1);
    expect(screen.getByText(WORDS).closest("[data-block]")).not.toBeNull();
    expect(document.querySelector("[data-slot='stream-pending']")).toBeNull();
  });

  it("Muse keeps the upstream handover timeout when no queue or user turn reaches the journal", () => {
    const view = render(stream("muse"));
    sentAndQueued();
    expect(screen.getAllByText(WORDS)).toHaveLength(1);

    act(() => vi.advanceTimersByTime(21_000));
    view.rerender(stream("muse"));
    expect(screen.queryByText(WORDS)).toBeNull();
    expect(document.querySelector("[data-slot='stream-pending']")).toBeNull();
  });
});
