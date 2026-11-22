import { act, render, screen } from "@testing-library/react";
import { createRef } from "react";

import type { ChatMessageListHandle } from "@/components/ui/chat/chat-message-list";
import type { ChatFeed } from "@/hooks/use-chat-window";
import { EMPTY_CHAT_WINDOW, type ChatWindow } from "@/lib/chat-window";
import { __resetPending, addPending, handOverPending, setPendingState } from "@/lib/durable-pending";
import { SessionStream } from "./session-stream";

// Oracle: fix brief, finding 2. The independent test author has not read the implementation.
const ADDRESS = "w1:p1";
const WORDS = "also check the phone layout";
const REQUEST = "direct-queued-0001";

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => __resetPending());
afterEach(() => __resetPending());

function stream(agent: "claude" | "codex", window: Partial<ChatWindow> = {}) {
  const feed: ChatFeed = {
    window: { ...EMPTY_CHAT_WINDOW, status: { kind: "live" }, ...window },
    loadOlder: vi.fn(), loadingOlder: false, asked: 0, answered: 0, tried: false,
  };
  return <SessionStream feed={feed} address={ADDRESS} working showToolCalls showCompactions={false} fontSize={14} listRef={createRef<ChatMessageListHandle>()} agent={agent} onSendQueuedNow={vi.fn(async () => true)} onReturned={vi.fn(async () => true)} />;
}

describe("@req:FIX-QUEUED-TEXT @oracle:requirement direct sends queued during a running turn", () => {
  it.each([
    { agent: "claude", source: "journal" },
    { agent: "codex", source: "journal" },
    { agent: "claude", source: "receipt" },
    { agent: "codex", source: "receipt" },
  ] as const)("$agent: a sent+queued answer keeps one stream line when the $source reports it", ({ agent, source }) => {
    const view = render(stream(agent));
    act(() => addPending(ADDRESS, { requestId: REQUEST, text: WORDS, at: Date.now(), state: "sending", seen: new Set() }));
    expect(screen.getAllByText(WORDS)).toHaveLength(1);

    act(() => {
      setPendingState(ADDRESS, REQUEST, "sent");
      handOverPending(ADDRESS, REQUEST);
    });
    const queued: Partial<ChatWindow> = source === "journal"
      ? { queued: [WORDS], sendQueuedNow: ["ctrl+Enter"] }
      : { queuedSends: [{ requestId: REQUEST, state: "queued", text: WORDS }] };
    view.rerender(stream(agent, queued));

    expect(screen.getAllByText(WORDS)).toHaveLength(1);
    expect(screen.getByText(WORDS).closest("[data-slot='stream-pending'], [data-block]")).not.toBeNull();
    expect(document.querySelector("[data-slot='stream-queued'], [data-slot='stream-queued-receipts']")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
  });
});
