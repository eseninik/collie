import { act, cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";

import type { ChatMessageListHandle } from "@/components/ui/chat/chat-message-list";
import type { ChatFeed } from "@/hooks/use-chat-window";
import { EMPTY_CHAT_WINDOW, type ChatWindow } from "@/lib/chat-window";
import { __resetPending, addPending, handOverPending, PENDING_KEEP_MS, setPendingState } from "@/lib/durable-pending";
import { en } from "@/lib/i18n/messages/en";
import { SessionStream } from "./session-stream";

// Oracle: the owner's R3 Chat requirements and the existing rule that two sends stay distinct.
const ADDRESS = "w1:p1";
const WORDS = "check the phone layout next";
const QUEUED = { requestId: "r1", state: "queued", text: WORDS } as const;

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-19T10:00:00.000Z"));
  __resetPending();
});
afterEach(() => {
  cleanup();
  __resetPending();
  vi.useRealTimers();
});

function stream(agent: "claude" | "codex", window: Partial<ChatWindow> = {}) {
  const feed: ChatFeed = {
    window: { ...EMPTY_CHAT_WINDOW, status: { kind: "live" }, queued: [], ...window },
    loadOlder: vi.fn(),
    loadingOlder: false,
    asked: 0,
    answered: 0,
    tried: false,
  };
  return (
    <SessionStream
      feed={feed}
      address={ADDRESS}
      agent={agent}
      working
      showToolCalls
      showCompactions={false}
      fontSize={14}
      listRef={createRef<ChatMessageListHandle>()}
      onSendQueuedNow={vi.fn(async () => true)}
      onReturned={vi.fn(async () => true)}
    />
  );
}

function sendPending(text: string) {
  act(() => {
    addPending(ADDRESS, { requestId: QUEUED.requestId, text, at: Date.now(), state: "sending", seen: new Set() });
    setPendingState(ADDRESS, QUEUED.requestId, "sent");
    handOverPending(ADDRESS, QUEUED.requestId);
  });
}

function expectNoQueueCardsOrActions(container: HTMLElement) {
  expect(container.querySelector(
    "[data-slot='stream-queued'], [data-slot='stream-queued-receipts'], [data-slot='stream-returned'], [data-slot='stream-unconfirmed']",
  )).toBeNull();
  for (const name of [
    en["chat.stream.sendNowAria"],
    en["chat.stream.returnedSendAria"],
    en["chat.stream.returnedDiscardAria"],
    en["chat.stream.unconfirmedDiscardAria"],
    en["composer.step.sendAgain"],
  ]) {
    expect(screen.queryByRole("button", { name })).toBeNull();
  }
}

describe("@req:FIX-DIRECT-RECEIPT-QUEUE @oracle:requirement receipt text in direct-send Chat", () => {
  it("Codex shows one queued receipt line without a local pending line or a native queue", () => {
    const { container } = render(stream("codex", { queuedSends: [QUEUED] }));

    expect(screen.getByText(WORDS)).toBeVisible();
    expectNoQueueCardsOrActions(container);
  });

  it("Codex shows one queued receipt line before and after the local pending timeout", () => {
    const { container, rerender } = render(stream("codex"));
    sendPending(WORDS);
    expect(screen.getByText(WORDS)).toBeVisible();

    rerender(stream("codex", { queuedSends: [QUEUED] }));
    expect(screen.getByText(WORDS)).toBeVisible();
    expectNoQueueCardsOrActions(container);

    act(() => vi.advanceTimersByTime(PENDING_KEEP_MS + 1));
    rerender(stream("codex", { queuedSends: [{ ...QUEUED }] }));
    expect(screen.getByText(WORDS)).toBeVisible();
    expectNoQueueCardsOrActions(container);
  });

  it.each(["returned", "unconfirmed"] as const)("Claude shows a %s receipt as an ordinary line while the receipt remains", (state) => {
    const receipt = { ...QUEUED, state };
    const { container, rerender } = render(stream("claude", { queuedSends: [receipt] }));
    expect(screen.getByText(WORDS)).toBeVisible();
    expectNoQueueCardsOrActions(container);

    act(() => vi.advanceTimersByTime(PENDING_KEEP_MS + 1));
    rerender(stream("claude", { queuedSends: [{ ...receipt }] }));
    expect(screen.getByText(WORDS)).toBeVisible();
    expectNoQueueCardsOrActions(container);
  });

  it("Codex keeps two sends with identical text and different request IDs", () => {
    const { container, rerender } = render(stream("codex"));
    sendPending(WORDS);
    const second = { ...QUEUED, requestId: "r2" };

    rerender(stream("codex", { queuedSends: [second] }));
    expect(screen.getAllByText(WORDS)).toHaveLength(2);

    rerender(stream("codex", { queuedSends: [QUEUED, second] }));
    expect(screen.getAllByText(WORDS)).toHaveLength(2);
    expectNoQueueCardsOrActions(container);
  });
});

describe("@req:FIX-DIRECT-QUEUE-WHITESPACE @oracle:requirement the native queue folds whitespace", () => {
  it("Claude shows one line when a multiline local send reaches the native queue on one line", () => {
    const { container, rerender } = render(stream("claude"));
    sendPending("line one\nline two");
    expect(screen.getByText("line one line two")).toBeVisible();

    rerender(stream("claude", { queued: ["line one line two"], sendQueuedNow: ["ctrl+Enter"] }));
    expect(screen.getByText("line one line two")).toBeVisible();
    expectNoQueueCardsOrActions(container);
  });
});
