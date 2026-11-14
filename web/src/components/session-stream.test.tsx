import { act, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";

import { SessionStream, type QueuedCardAction } from "./session-stream";
import type { ChatFeed } from "@/hooks/use-chat-window";
import type { ChatMessageListHandle } from "@/components/ui/chat/chat-message-list";
import { EMPTY_CHAT_WINDOW, type ChatWindow } from "@/lib/chat-window";
import type { ChatItem } from "@/lib/chat-items";
import type { ChatEntry } from "@/lib/types";
import { BLOCK_HOLD_MS } from "./stream-block";

// The pane view's second body. The load-bearing behaviours: the two empty answers are never drawn
// alike, a pane with nothing to read says nothing until it has actually asked, older turns come off
// `hasOlder` and nothing else, and a rewound turn is not part of the conversation.
//
// It takes a FEED rather than a paneId, so every case here is a plain render with no network: the
// fetching lives in `hooks/use-chat-window.ts` and the merge in `lib/chat-window.ts`.

beforeAll(() => {
  // jsdom doesn't implement scrollTo; ChatMessageList's auto-scroll calls it on mount.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

const BASE = 1_000_000;

function entry(uuid: string, seq: number, text: string, over: Partial<ChatEntry> = {}): ChatEntry {
  return {
    uuid,
    seq,
    ts: "2026-09-30T10:00:00.000Z",
    role: "assistant",
    parts: [{ kind: "text", text }],
    ...over,
  };
}

function feedOf(window: Partial<ChatWindow>, over: Partial<ChatFeed> = {}): ChatFeed {
  return {
    window: { ...EMPTY_CHAT_WINDOW, ...window },
    loadOlder: vi.fn(),
    loadingOlder: false,
    asked: 0,
    answered: 0,
    tried: false,
    ...over,
  };
}

function renderStream(
  feed: ChatFeed,
  showToolCalls = true,
  working = false,
  starting = false,
  onSendQueuedNow?: (keys: readonly string[]) => Promise<boolean>,
) {
  const listRef = createRef<ChatMessageListHandle>();
  return render(
    <SessionStream
      feed={feed}
      address="w1:p1"
      working={working}
      starting={starting}
      showToolCalls={showToolCalls}
      showCompactions={false}
      fontSize={14}
      listRef={listRef}
      onSendQueuedNow={onSendQueuedNow}
      agent="muse"
    />,
  );
}

describe("SessionStream", () => {
  it("draws the turns it holds, oldest first", () => {
    renderStream(
      feedOf({
        status: { kind: "live" },
        entries: [entry("a", BASE, "first"), entry("b", BASE + 1, "second")],
      }),
    );
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(screen.getByText("second")).toBeInTheDocument();
  });

  it("says nothing at all before the first answer has landed", () => {
    const { container } = renderStream(feedOf({}));
    expect(container.querySelectorAll("[data-block]")).toHaveLength(0);
    expect(screen.queryByText(/session/i)).toBeNull();
  });

  it("says a live session is empty only once the window has answered", () => {
    renderStream(feedOf({ status: { kind: "live" } }));
    expect(screen.getByText("Send a message to start.")).toBeInTheDocument();
  });

  // 1.17.0: a NEW pane has nothing to read, and that is expected (lib/chat-gate.ts). It says how to
  // begin, never the readings that are only true of a pane that should have a log by now.
  it("on a new pane, says how to begin instead of reporting a missing session or log", () => {
    for (const status of [
      { kind: "empty" },
      { kind: "unavailable", reason: "no-session" },
      { kind: "unavailable", reason: "no-log" },
    ] as const) {
      const r = renderStream(feedOf({ status }), true, false, true);
      expect(screen.getByText("Send a message to start.")).toBeInTheDocument();
      expect(screen.queryByText(/no agent session|No transcript file/)).toBeNull();
      r.unmount();
    }
  });

  it("on a new pane that is working, shows the running turn and not the line that says how to begin", () => {
    renderStream(feedOf({ status: { kind: "unavailable", reason: "no-log" } }), true, true, true);
    expect(screen.getByText("Still working…")).toBeInTheDocument();
    expect(screen.queryByText("Send a message to start.")).toBeNull();
  });

  it("a pane that is not new still says its log is missing", () => {
    renderStream(feedOf({ status: { kind: "unavailable", reason: "no-log" } }));
    expect(screen.getByText("No transcript file was found for this pane's session yet.")).toBeInTheDocument();
    expect(screen.queryByText("Send a message to start.")).toBeNull();
  });

  // #508: the bridge refused to guess between two Muse sessions in one folder. The empty Chat says
  // why and how to fix it, on a new pane too, since nothing will appear on its own.
  it("names a shared folder and its remedy under the empty state, and only when the bridge says so", () => {
    const line =
      "Two Muse sessions share this folder, so Collie cannot tell which one is this pane's. Start the agent with its resume command and session id, then Collie reads the right one.";
    for (const starting of [false, true]) {
      const r = renderStream(
        feedOf({ status: { kind: "unavailable", reason: "no-session", detail: "shared-folder" } }),
        true,
        false,
        starting,
      );
      expect(screen.getByText(line)).toBeInTheDocument();
      expect(screen.getByText(/no agent session/)).toBeInTheDocument();
      expect(screen.queryByText("Send a message to start.")).toBeNull();
      r.unmount();
    }
    renderStream(feedOf({ status: { kind: "unavailable", reason: "no-session" } }));
    expect(screen.queryByText(/share this folder/)).toBeNull();
  });

  // ADR 0073 point 7: a 404 means "update this member", never "this pane has nothing to show".
  it("tells a machine a release behind apart from a pane with no session", () => {
    const stale = renderStream(feedOf({ status: { kind: "stale" } }));
    expect(
      screen.getByText("This machine runs an older Collie. Update it to follow the conversation here."),
    ).toBeInTheDocument();
    stale.unmount();

    renderStream(feedOf({ status: { kind: "unavailable", reason: "no-session" } }));
    expect(
      screen.getByText("This pane has no agent session, so there's no transcript to read."),
    ).toBeInTheDocument();
  });

  it("keeps the turns a stale answer arrived after — a version skew does not unsay them", () => {
    renderStream(feedOf({ status: { kind: "stale" }, entries: [entry("a", BASE, "said this")] }));
    expect(screen.getByText("said this")).toBeInTheDocument();
    expect(screen.getByText(/older Collie/)).toBeInTheDocument();
  });

  it("offers older turns only where the window says there are some", () => {
    const none = renderStream(
      feedOf({ status: { kind: "live" }, entries: [entry("a", BASE, "hi")], hasOlder: false }),
    );
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
    expect(screen.getByText("Start of the conversation")).toBeInTheDocument();
    none.unmount();

    const loadOlder = vi.fn();
    renderStream(
      feedOf({ status: { kind: "live" }, entries: [entry("a", BASE, "hi")], hasOlder: true }, { loadOlder }),
    );
    expect(screen.getByRole("button", { name: "Load older" })).toBeInTheDocument();
    expect(screen.queryByText("Start of the conversation")).toBeNull();
  });

  it("asks for the older page on a tap, and says so while it is in flight", async () => {
    const user = userEvent.setup();
    const loadOlder = vi.fn();
    const { rerender } = renderStream(
      feedOf({ status: { kind: "live" }, entries: [entry("a", BASE, "hi")], hasOlder: true }, { loadOlder }),
    );
    await user.click(screen.getByRole("button", { name: "Load older" }));
    expect(loadOlder).toHaveBeenCalledOnce();

    const listRef = createRef<ChatMessageListHandle>();
    rerender(
      <SessionStream
        feed={feedOf(
          { status: { kind: "live" }, entries: [entry("a", BASE, "hi")], hasOlder: true },
          { loadOlder, loadingOlder: true },
        )}
        address="w1:p1"
        working={false}
        showToolCalls
        showCompactions={false}
        fontSize={14}
        listRef={listRef}
      />,
    );
    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();
  });

  // jsdom has no layout, so the scroller's two numbers are faked. What is under test is the
  // ARITHMETIC: the reader gets back exactly the height that went in above them.
  it("a page of older turns leaves the reader where they were, not at the top", async () => {
    const user = userEvent.setup();
    const loadOlder = vi.fn();
    const newer = [entry("b", BASE + 1, "newer")];
    const listRef = createRef<ChatMessageListHandle>();
    const draw = (entries: ChatEntry[], hasOlder: boolean) => (
      <SessionStream
        feed={feedOf({ status: { kind: "live" }, entries, hasOlder }, { loadOlder })}
        address="w1:p1"
        working={false}
        showToolCalls
        showCompactions={false}
        fontSize={14}
        listRef={listRef}
      />
    );
    const { rerender } = render(draw(newer, true));

    const el = listRef.current!.getScrollElement()!;
    let height = 1000;
    let top = 0;
    Object.defineProperty(el, "scrollHeight", { get: () => height, configurable: true });
    Object.defineProperty(el, "scrollTop", {
      get: () => top,
      set: (v: number) => {
        top = v;
      },
      configurable: true,
    });
    top = 400;

    await user.click(screen.getByRole("button", { name: "Load older" }));
    expect(loadOlder).toHaveBeenCalledOnce();

    // The page lands: 600px of older turns went in ABOVE the viewport.
    height = 1600;
    rerender(draw([entry("a", BASE, "older"), ...newer], false));
    expect(el.scrollTop).toBe(1000);
  });

  it("a turn arriving at the TAIL while a page is in flight does not spend the anchor", async () => {
    const user = userEvent.setup();
    const loadOlder = vi.fn();
    const listRef = createRef<ChatMessageListHandle>();
    const draw = (entries: ChatEntry[], loadingOlder: boolean) => (
      <SessionStream
        feed={feedOf(
          { status: { kind: "live" }, entries, hasOlder: true },
          { loadOlder, loadingOlder },
        )}
        address="w1:p1"
        working={false}
        showToolCalls
        showCompactions={false}
        fontSize={14}
        listRef={listRef}
      />
    );
    const first = entry("a", BASE, "first");
    const { rerender } = render(draw([first], false));

    const el = listRef.current!.getScrollElement()!;
    let height = 1000;
    let top = 0;
    Object.defineProperty(el, "scrollHeight", { get: () => height, configurable: true });
    Object.defineProperty(el, "scrollTop", {
      get: () => top,
      set: (v: number) => {
        top = v;
      },
      configurable: true,
    });
    top = 400;

    await user.click(screen.getByRole("button", { name: "Load older" }));
    height = 1400;
    rerender(draw([first, entry("z", BASE + 9, "a reply landed")], true));
    expect(el.scrollTop).toBe(400);

    // And the real page still gets its anchor when it arrives. The delta is measured from the tap,
    // so the 400px the tail grew by is in it: a hair low rather than a screen out.
    height = 2000;
    rerender(draw([entry("older", BASE - 1, "older"), first], false));
    expect(el.scrollTop).toBe(1400);
  });

  // The journal KEEPS a rewound turn so a `?before=` cursor can still resolve its uuid; hiding it is
  // the reader's job, here as on the History page (ADR 0073's addendum).
  it("hides a turn the agent rewound past", () => {
    renderStream(
      feedOf({
        status: { kind: "live" },
        entries: [entry("a", BASE, "kept"), entry("b", BASE + 1, "abandoned", { abandoned: true })],
      }),
    );
    expect(screen.getByText("kept")).toBeInTheDocument();
    expect(screen.queryByText("abandoned")).toBeNull();
  });

  it("folds a lone step to one line while tool calls are off, and draws it while they are on", () => {
    const off = renderStream(
      feedOf({
        status: { kind: "live" },
        entries: [
          entry("a", BASE, "", {
            // A FINISHED step: a run with anything still running stays open by design, and this
            // case is about the fold.
            parts: [
              {
                kind: "tool",
                id: "t1",
                name: "Read",
                summary: "/a.ts",
                call: { kind: "read", path: "/a.ts" },
                result: { text: "" },
              },
            ],
          }),
        ],
      }),
      false,
    );
    expect(screen.getByRole("button", { expanded: false })).toHaveTextContent("1 read");
    off.unmount();

    renderStream(
      feedOf({
        status: { kind: "live" },
        entries: [
          entry("a", BASE, "", {
            // A FINISHED step: a run with anything still running stays open by design, and this
            // case is about the fold.
            parts: [
              {
                kind: "tool",
                id: "t1",
                name: "Read",
                summary: "/a.ts",
                call: { kind: "read", path: "/a.ts" },
                result: { text: "" },
              },
            ],
          }),
        ],
      }),
      true,
    );
    expect(screen.getByText("Read")).toBeInTheDocument();
  });
  describe("an agent call in a turn of steps", () => {
    const exec = (n: number): ChatEntry["parts"][number] => ({
      kind: "tool",
      id: `x${n}`,
      name: "Bash",
      summary: `cmd ${n}`,
      call: { kind: "execute", command: `cmd ${n}` },
      result: { text: "" },
    });
    const agent = (result?: string): ChatEntry["parts"][number] => {
      const part: ChatEntry["parts"][number] = {
        kind: "tool",
        id: "ag1",
        name: "Agent",
        summary: "Map the routes",
        call: { kind: "task", agent: "Explore", summary: "Map the routes", agentId: "a1" },
      };
      if (result !== undefined) part.result = { text: result };
      return part;
    };
    const turn = (middle: ChatEntry["parts"][number]) =>
      feedOf({
        status: { kind: "live" },
        entries: [
          entry("a", BASE, "", {
            parts: [...[1, 2, 3, 4, 5].map(exec), middle, ...[6, 7, 8].map(exec)],
          }),
        ],
      });

    it("draws one fold of five, the agent card, then one fold of three, in that order", () => {
      renderStream(turn(agent("Found 23 routes.")));
      const blocks = [...document.querySelectorAll("[data-block]")];
      expect(blocks).toHaveLength(3);
      expect(blocks[0]).toHaveTextContent("5 commands");
      expect(blocks[1]).toHaveTextContent("Agent · Explore");
      expect(blocks[1]).toHaveTextContent("Map the routes");
      expect(blocks[2]).toHaveTextContent("3 commands");
      expect(screen.queryByText(/agent$/)).toBeNull();
    });

    it("shows a running agent as running, and a finished one as a tappable card with its report", () => {
      const running = renderStream(turn(agent()));
      expect(screen.getByRole("img", { name: /running/i })).toBeInTheDocument();
      running.unmount();
      renderStream(turn(agent("Found 23 routes.")));
      expect(screen.queryByRole("img", { name: /running/i })).toBeNull();
      expect(screen.getByRole("button", { name: /Agent · Explore/ })).toBeInTheDocument();
    });

    it("draws a turn of only an agent call as the card with no fold, with tool calls on or off", () => {
      const only = feedOf({ status: { kind: "live" }, entries: [entry("a", BASE, "", { parts: [agent("Done.")] })] });
      const on = renderStream(only, true);
      expect(screen.getByRole("button", { name: /Agent · Explore/ })).toBeInTheDocument();
      expect(screen.queryByText("1 agent")).toBeNull();
      on.unmount();
      renderStream(only, false);
      expect(screen.getByRole("button", { name: /Agent · Explore/ })).toBeInTheDocument();
      expect(screen.queryByText("1 agent")).toBeNull();
    });
  });

  it("draws the agent's own walky talky send as its card between two folds, even with tool calls off", () => {
    const exec = (n: number, command: string): ChatEntry["parts"][number] => ({
      kind: "tool",
      id: `w${n}`,
      name: "Bash",
      summary: command,
      call: { kind: "execute", command },
      result: { text: "" },
    });
    const feed = feedOf({
      status: { kind: "live" },
      entries: [
        entry("a", BASE, "", {
          parts: [
            exec(1, "ls"),
            exec(2, "pwd"),
            exec(3, 'collie walky send bluefin/w6:p3 "Merged."'),
            exec(4, "git status"),
            exec(5, "git log"),
          ],
        }),
      ],
    });
    renderStream(feed, false);
    const blocks = [...document.querySelectorAll("[data-block]")];
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toHaveTextContent("2 commands");
    expect(blocks[1]!.querySelector('[data-slot="walky-tool-badge"]')).not.toBeNull();
    expect(blocks[1]).not.toHaveTextContent("command");
    expect(blocks[2]).toHaveTextContent("2 commands");
  });

  // ── the tail row: a turn in flight ────────────────────────────────────────
  // The mirror shows the agent's own spinner; this body draws the record, and a record gains nothing
  // while a compaction runs. Without this row a compacting session looked exactly like a finished one.
  it("says a turn is still running while the agent is working", () => {
    renderStream(feedOf({ status: { kind: "live" }, entries: [entry("a", BASE, "hi")] }), true, true);
    expect(screen.getByText("Still working…")).toBeInTheDocument();
  });

  it("says nothing while the agent is idle", () => {
    renderStream(feedOf({ status: { kind: "live" }, entries: [entry("a", BASE, "hi")] }), true, false);
    expect(screen.queryByText("Still working…")).not.toBeInTheDocument();
  });

  it("says nothing over a journal it cannot read, busy or not", () => {
    // Busy in the chrome is true; promising a turn this body will never draw is not.
    renderStream(
      feedOf({ status: { kind: "unavailable", reason: "no-session" }, entries: [] }),
      true,
      true,
    );
    expect(screen.queryByText("Still working…")).not.toBeInTheDocument();
  });

  // OmO's `? Question pending` banner over a ready editor (pi/ask.ts piQuestionBanner): the terminal
  // shows it, and Chat said nothing. One line now says a question waits, with no control.
  it("says a question waits in the terminal, in place of the working line, with no control", () => {
    const listRef = createRef<ChatMessageListHandle>();
    const { container } = render(
      <SessionStream
        feed={feedOf({ status: { kind: "live" }, entries: [entry("a", BASE, "hi")] })}
        address="w1:p1"
        working
        questionPending
        showToolCalls
        showCompactions={false}
        fontSize={14}
        listRef={listRef}
      />,
    );
    const row = container.querySelector("[data-slot='stream-question-pending']");
    expect(row).toHaveTextContent("A question is waiting in the terminal. Your next message answers it.");
    expect(row?.querySelector("button")).toBeNull();
    expect(container.querySelector("[data-slot='stream-live']")).toBeNull();
    const rows = [...container.querySelectorAll("[data-block], [data-slot='stream-question-pending']")];
    expect(rows.at(-1)?.getAttribute("data-slot")).toBe("stream-question-pending");
  });

  it("stands at the END of the thread, where the answer will arrive", () => {
    const { container } = renderStream(
      feedOf({ status: { kind: "live" }, entries: [entry("a", BASE, "hi")] }),
      true,
      true,
    );
    const blocks = [...container.querySelectorAll("[data-block], [data-slot='stream-live']")];
    expect(blocks.at(-1)?.getAttribute("data-slot")).toBe("stream-live");
  });
});

// ── what you typed that has not started yet (M41/12) ─────────────────────────
//
// The other half of the same blindness: a compaction runs, you queue a message, and nothing on the
// phone says the message exists. It is state and not a turn, so it is a row of its own.
describe("SessionStream — the queue", () => {
  it("shows what you typed that has not been started", () => {
    renderStream(
      feedOf({
        status: { kind: "live" },
        entries: [entry("a", BASE, "hi")],
        queued: ["and the tests too"],
      }),
      true,
      true,
    );
    expect(screen.getByText("Waiting to send")).toBeInTheDocument();
    expect(screen.getByText("and the tests too")).toBeInTheDocument();
  });

  it("shows every waiting message, oldest first", () => {
    const { container } = renderStream(
      feedOf({ status: { kind: "live" }, entries: [], queued: ["first", "second"] }),
      true,
      true,
    );
    const texts = [...container.querySelectorAll("[data-slot='stream-queued'] p")].map((p) => p.textContent);
    expect(texts).toEqual(["Waiting to send", "first", "second"]);
  });

  it("draws it even when the pane does not read as working", () => {
    // The reported gap is exactly the moment those two disagree. A queued message is a fact on its own.
    renderStream(feedOf({ status: { kind: "live" }, entries: [], queued: ["mine"] }), true, false);
    expect(screen.getByText("mine")).toBeInTheDocument();
  });

  it("says nothing when nothing is waiting", () => {
    const { container } = renderStream(
      feedOf({ status: { kind: "live" }, entries: [entry("a", BASE, "hi")], queued: [] }),
      true,
      true,
    );
    expect(container.querySelector("[data-slot='stream-queued']")).toBeNull();
  });

  it("says nothing over a journal it cannot read", () => {
    const { container } = renderStream(
      feedOf({ status: { kind: "unavailable", reason: "no-session" }, queued: ["mine"] }),
      true,
      true,
    );
    expect(container.querySelector("[data-slot='stream-queued']")).toBeNull();
  });

  it("stands under the working mark, at the end of the thread", () => {
    const { container } = renderStream(
      feedOf({ status: { kind: "live" }, entries: [entry("a", BASE, "hi")], queued: ["mine"] }),
      true,
      true,
    );
    const rows = [
      ...container.querySelectorAll("[data-block], [data-slot='stream-live'], [data-slot='stream-queued']"),
    ].map((el) => el.getAttribute("data-slot"));
    expect(rows.slice(-2)).toEqual(["stream-live", "stream-queued"]);
  });

  it("shows two identical queued messages as two", () => {
    const { container } = renderStream(
      feedOf({ status: { kind: "live" }, entries: [], queued: ["same", "same"] }),
      true,
      true,
    );
    const texts = [...container.querySelectorAll("[data-slot='stream-queued'] p")].map((p) => p.textContent);
    expect(texts).toEqual(["Waiting to send", "same", "same"]);
  });
});

// ── "Send now" on the waiting card ───────────────────────────────────────────
//
// The keys are DATA from the bridge (`ChatWindow.sendQueuedNow`), so these cases name no harness. The
// pane view hands `onSendQueuedNow` over only where this device may write; leaving it out is how
// every "nothing may act" state loses the button.
describe("SessionStream — Send now", () => {
  const live = (over: Partial<ChatWindow> = {}) =>
    feedOf({ status: { kind: "live" }, entries: [], queued: ["first", "second"], sendQueuedNow: ["ctrl+Enter"], ...over });

  it("shows one button on the group, beside the label, when the bridge declared keys and the device can write", () => {
    const { container } = renderStream(live(), true, true, false, vi.fn(async () => true));
    const buttons = container.querySelectorAll("[data-slot='stream-send-now']");
    expect(buttons).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Send now, the waiting messages" })).toHaveTextContent("Send now");
    // In the head row with the label, not among the message paragraphs.
    expect(buttons[0]!.parentElement).toBe(container.querySelector("[data-slot='stream-queued'] > div"));
  });

  it("is absent when the bridge declared no keys", () => {
    const { container } = renderStream(live({ sendQueuedNow: [] }), true, true, false, vi.fn(async () => true));
    expect(container.querySelector("[data-slot='stream-send-now']")).toBeNull();
  });

  it("is absent when the device cannot act, because the handler is withheld", () => {
    const { container } = renderStream(live(), true, true);
    expect(container.querySelector("[data-slot='stream-queued']")).not.toBeNull();
    expect(container.querySelector("[data-slot='stream-send-now']")).toBeNull();
  });

  it("is absent when nothing is waiting, however many keys are declared", () => {
    const { container } = renderStream(live({ queued: [] }), true, true, false, vi.fn(async () => true));
    expect(container.querySelector("[data-slot='stream-send-now']")).toBeNull();
  });

  it("is absent on a window that is not live", () => {
    const { container } = renderStream(
      live({ status: { kind: "unavailable", reason: "no-log" } }),
      true,
      true,
      false,
      vi.fn(async () => true),
    );
    expect(container.querySelector("[data-slot='stream-send-now']")).toBeNull();
  });

  it("a tap hands the declared keys over once, shows pending, and a second tap sends nothing", async () => {
    let finish: (sent: boolean) => void = () => {};
    const send = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    renderStream(live({ sendQueuedNow: ["ctrl+Enter"] }), true, true, false, send);
    const button = screen.getByRole("button", { name: "Send now, the waiting messages" });
    await userEvent.click(button);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(["ctrl+Enter"]);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await userEvent.click(button);
    expect(send).toHaveBeenCalledTimes(1);
    finish(true);
  });

  it("drops the pending face at once when nothing was sent", async () => {
    const send = vi.fn(async () => false);
    renderStream(live(), true, true, false, send);
    const button = screen.getByRole("button", { name: "Send now, the waiting messages" });
    await userEvent.click(button);
    await vi.waitFor(() => expect(button).not.toBeDisabled());
    expect(button).toHaveAttribute("aria-busy", "false");
  });

  it("drops the pending face after five seconds and never sends again on its own", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const send = vi.fn(async () => true);
      renderStream(live(), true, true, false, send);
      const button = screen.getByRole("button", { name: "Send now, the waiting messages" });
      await userEvent.click(button);
      expect(button).toBeDisabled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100);
      });
      expect(button).not.toBeDisabled();
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names no harness: the component source holds no quoted harness name", async () => {
    // SAFETY: Vite's `?raw` import is a string module by contract; the dynamic import only types it as unknown.
    const source = (await import("./session-stream.tsx?raw")).default as string;
    for (const name of ["claude", "codex", "opencode", "grok", "hermes", "muse", "pi", "omp"]) {
      expect(source).not.toMatch(new RegExp(`["'\\u0060]${name}["'\\u0060]`, "i"));
    }
  });
});

// A durable pane's asks (ADR 0100): a card sits under the block that shows its item, else at the tail.
// ── The receipt queue (ADR 0122) ────────────────────────────────────────────
//
// Rows from Collie's own receipts: still waiting (no button at all, one sentence), or given back to the
// input box by a Stop (Send and Discard). The journal's own queue card is the "Send now" block above.
describe("SessionStream — queued sends from the receipts", () => {
  function renderReceipts(window: Partial<ChatWindow>, onReturned?: (requestId: string, action: QueuedCardAction) => Promise<boolean>, agent = "muse") {
    const listRef = createRef<ChatMessageListHandle>();
    return render(
      <SessionStream
        feed={feedOf({ status: { kind: "live" }, entries: [], ...window })}
        address="w1:p1"
        working
        showToolCalls
        showCompactions={false}
        fontSize={14}
        listRef={listRef}
        onReturned={onReturned}
        agent={agent}
      />,
    );
  }
  const QUEUED = { requestId: "req-queued-0001", state: "queued", text: "still waiting" } as const;
  const BACK = { requestId: "req-back-00001", state: "returned", text: "second message" } as const;

  const LOST = { requestId: "req-lost-00001", state: "unconfirmed", text: "where did it go" } as const;

  it("a waiting row says it waits for the turn and that Stop takes it back, and offers no button: no Send now, no Cancel", () => {
    const { container } = renderReceipts({ queuedSends: [QUEUED] }, vi.fn(async () => true));
    const card = container.querySelector("[data-slot='stream-queued-receipts']")!;
    expect([...card.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
      "Waiting to send",
      "Waits for the turn to end.",
      "To take it back, stop the turn.",
      "still waiting",
    ]);
    expect(card.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelector("[data-slot='stream-returned']")).toBeNull();
  });

  it("a returned row says Stop put it back, and offers Send and Discard", () => {
    const { container } = renderReceipts({ queuedSends: [BACK] }, vi.fn(async () => true));
    const card = container.querySelector("[data-slot='stream-returned']")!;
    expect([...card.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
      "Back in the box",
      "Stop put your message back as a draft in the agent. Send it or discard it.",
      "second message",
    ]);
    expect(screen.getByRole("button", { name: "Send this message from the agent's box" })).toHaveTextContent("Send");
    expect(screen.getByRole("button", { name: "Discard this message from the agent's box" })).toHaveTextContent("Discard");
    expect(container.querySelector("[data-slot='stream-queued-receipts']")).toBeNull();
  });

  it("an unconfirmed card says Collie cannot tell, and offers Discard alone, which asks to dismiss", async () => {
    const onReturned = vi.fn(async () => true);
    const { container } = renderReceipts({ queuedSends: [LOST] }, onReturned);
    const card = container.querySelector("[data-slot='stream-unconfirmed']")!;
    expect([...card.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
      "Not confirmed",
      "Collie cannot tell where this message went. Check the agent.",
      "where did it go",
    ]);
    expect(card.querySelectorAll("button")).toHaveLength(1);
    const discard = screen.getByRole("button", { name: "Discard this card. Nothing is sent to the agent." });
    expect(discard).toHaveTextContent("Discard");
    await userEvent.click(discard);
    expect(onReturned).toHaveBeenCalledWith("req-lost-00001", "dismiss");
  });

  it("a returned run is one card with its joined text and one pair of buttons", () => {
    const run = { requestId: "req-run-000001", state: "returned", text: "alpha one\nbeta two" } as const;
    const { container } = renderReceipts({ queuedSends: [run] }, vi.fn(async () => true));
    expect(container.querySelectorAll("[data-slot='stream-returned']")).toHaveLength(1);
    expect(container.querySelectorAll("[data-slot='stream-returned'] button")).toHaveLength(2);
    expect(screen.getByText(/alpha one/u)).toHaveTextContent("alpha one beta two");
  });

  it("a journal queue and a receipt queue stand side by side, each once", () => {
    const { container } = renderReceipts({ queued: ["from the log"], queuedSends: [QUEUED, BACK] });
    expect(container.querySelectorAll("[data-slot='stream-queued']")).toHaveLength(1);
    expect(container.querySelectorAll("[data-slot='stream-queued-receipts']")).toHaveLength(1);
    expect(container.querySelectorAll("[data-slot='stream-returned']")).toHaveLength(1);
  });

  it("the returned card's buttons are withheld where the device cannot act", () => {
    const { container } = renderReceipts({ queuedSends: [BACK] });
    expect(container.querySelector("[data-slot='stream-returned']")).not.toBeNull();
    expect(container.querySelectorAll("[data-slot='stream-returned'] button")).toHaveLength(0);
  });

  it("Send and Discard hand the row's request id and the act over, once, and wait while it runs", async () => {
    let finish: (done: boolean) => void = () => undefined;
    const onReturned = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    renderReceipts({ queuedSends: [BACK] }, onReturned);
    const send = screen.getByRole("button", { name: "Send this message from the agent's box" });
    const discard = screen.getByRole("button", { name: "Discard this message from the agent's box" });
    await userEvent.click(send);
    expect(onReturned).toHaveBeenCalledWith("req-back-00001", "submit");
    expect(send).toBeDisabled();
    expect(discard).toBeDisabled();
    await userEvent.click(discard);
    expect(onReturned).toHaveBeenCalledTimes(1);
    // Nothing was done: both come back, and Discard asks for its own act.
    await act(async () => finish(false));
    expect(send).not.toBeDisabled();
    await userEvent.click(discard);
    expect(onReturned).toHaveBeenLastCalledWith("req-back-00001", "discard");
  });

  it.each(["claude", "codex"])("draws no waiting, returned or unconfirmed card on %s, which sends directly (owner, 2026-11-14)", (agent) => {
    const { container } = renderReceipts({ queuedSends: [QUEUED, BACK, LOST] }, vi.fn(async () => true), agent);
    expect(container.querySelector("[data-slot='stream-queued-receipts']")).toBeNull();
    expect(container.querySelector("[data-slot='stream-returned']")).toBeNull();
    expect(container.querySelector("[data-slot='stream-unconfirmed']")).toBeNull();
  });

  it.each(["claude", "codex"])("draws no journal waiting card on %s either (owner, 2026-11-14)", (agent) => {
    const { container } = renderReceipts({ queued: ["from the log"] }, vi.fn(async () => true), agent);
    expect(container.querySelector("[data-slot='stream-queued']")).toBeNull();
  });

  it("draws nothing on a window that is not live", () => {
    const { container } = renderReceipts({ status: { kind: "unavailable", reason: "no-log" }, queuedSends: [QUEUED, BACK] });
    expect(container.querySelector("[data-slot='stream-queued-receipts']")).toBeNull();
    expect(container.querySelector("[data-slot='stream-returned']")).toBeNull();
  });
});

describe("SessionStream: asks", () => {
  const ask = (id: string, itemId: string) => ({
    id,
    kind: "permission",
    toolCallId: `c-${id}`,
    revision: 1,
    title: `Question ${id}`,
    itemId,
    options: [{ id: "yes", label: `Yes ${id}`, effect: "allow" as const }],
  });

  function draw(list: ReturnType<typeof ask>[]) {
    const listRef = createRef<ChatMessageListHandle>();
    return render(
      <SessionStream
        feed={feedOf({
          status: { kind: "live" },
          entries: [entry("a", BASE, "first"), entry("b", BASE + 1, "second")],
        })}
        address="c1"
        working={false}
        showToolCalls
        showCompactions={false}
        fontSize={14}
        listRef={listRef}
        asks={{ list, card: { paneId: "c1" } }}
      />,
    );
  }

  it("puts a card inside the block of its item, and an unplaced one after every block", () => {
    const { container } = draw([ask("1", "a"), ask("2", "nowhere")]);
    const blocks = [...container.querySelectorAll("[data-block]")];
    const placed = screen.getByRole("button", { name: /Yes 1$/ });
    const tail = screen.getByRole("button", { name: /Yes 2$/ });
    expect(blocks[0]).toContainElement(placed);
    expect(blocks.some((b) => b.contains(tail))).toBe(false);
  });

  it("draws the first five and folds the rest behind an N more button", async () => {
    const list = Array.from({ length: 8 }, (_, i) => ask(String(i + 1), "nowhere"));
    draw(list);
    expect(screen.getAllByRole("button", { name: /^Allow/ })).toHaveLength(5);
    expect(screen.queryByText("Question 6")).toBeNull();
    const more = screen.getByRole("button", { name: "Show 3 more" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await userEvent.setup().click(more);
    expect(screen.getAllByRole("button", { name: /^Allow/ })).toHaveLength(8);
    expect(screen.getByText("Question 8")).toBeInTheDocument();
    const fewer = screen.getByRole("button", { name: "Show fewer" });
    expect(fewer).toHaveAttribute("aria-expanded", "true");
    await userEvent.setup().click(fewer);
    expect(screen.getAllByRole("button", { name: /^Allow/ })).toHaveLength(5);
  });

  it("five or fewer asks draw no more row", () => {
    draw(Array.from({ length: 5 }, (_, i) => ask(String(i + 1), "nowhere")));
    expect(document.querySelector('[data-slot="stream-ask-more"]')).toBeNull();
  });

  it("placement applies to the shown subset: a hidden ask under a block draws nothing there", () => {
    const list = [...Array.from({ length: 5 }, (_, i) => ask(String(i + 1), "nowhere")), ask("6", "a")];
    const { container } = draw(list);
    expect(screen.queryByText("Question 6")).toBeNull();
    expect(container.querySelector("[data-block]")?.querySelector('[role="group"]')).toBeNull();
  });

  it("a pane that carries no asks draws no card", () => {
    renderStream(feedOf({ status: { kind: "live" }, entries: [entry("a", BASE, "first")] }));
    expect(document.querySelector('[data-slot="stream-ask"]')).toBeNull();
  });
});

// Owner requirement NO-PROMPT-PIN replaces the old automatic prompt pin.
// Fixed row geometry exercises both the top of the thread and a reader farther down it.
describe("SessionStream — no prompt banner @oracle:requirement @req:NO-PROMPT-PIN", () => {
  let scrolled = 0;

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (!this.hasAttribute("data-block")) return DOMRect.fromRect({ x: 0, y: 0, width: 390, height: 600 });
      const index = [...(this.parentElement?.querySelectorAll(":scope > [data-block]") ?? [])].indexOf(this);
      return DOMRect.fromRect({ x: 0, y: index * 100 - scrolled, width: 390, height: 100 });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const replies = [entry("a", BASE + 10, "first visible reply"), entry("b", BASE + 11, "second visible reply"), entry("c", BASE + 12, "third visible reply")];
  const cases: { name: string; window: Partial<ChatWindow> }[] = [
    {
      name: "a held prompt",
      window: { entries: [entry("p1", BASE, "fix the flaky test", { role: "user" }), ...replies], hasOlder: true },
    },
    {
      name: "a reported prompt outside the loaded history",
      window: { entries: replies, hasOlder: true, lastPrompt: { uuid: "p1", ts: "", text: "rename the route" } },
    },
    { name: "an unavailable earlier prompt", window: { entries: replies, hasOlder: true } },
  ];

  function draw(window: Partial<ChatWindow>, over: Partial<ChatFeed> = {}) {
    const listRef = createRef<ChatMessageListHandle>();
    const feed = feedOf({ status: { kind: "live" }, ...window }, over);
    const view = render(
      <SessionStream
        feed={feed}
        address="w1:p1"
        working={false}
        showToolCalls
        showCompactions={false}
        fontSize={14}
        listRef={listRef}
      />,
    );
    return { ...view, feed, scrollport: listRef.current!.getScrollElement()! };
  }

  for (const { name, window } of cases) {
    for (const top of [0, 250]) {
      it(`keeps the history readable without either banner for ${name}, scroll ${top}`, () => {
        scrolled = top;
        const { container, scrollport, feed } = draw(window);
        fireEvent.scroll(scrollport, { target: { scrollTop: top } });
        expect(screen.getByText("first visible reply")).toBeInTheDocument();
        expect(screen.getByText("second visible reply")).toBeInTheDocument();
        expect(container.querySelector('[data-slot="prompt-pin"]')).toBeNull();
        expect(screen.queryByText("Asked further back")).toBeNull();
        expect(screen.queryByRole("button", { name: /fix the flaky test|rename the route|Asked further back/ })).toBeNull();
        if (name === "a held prompt") expect(screen.getByText("fix the flaky test")).toBeInTheDocument();
        if (name !== "a held prompt") expect(screen.queryByText("rename the route")).toBeNull();
        expect(feed.loadOlder).not.toHaveBeenCalled();
      });

      it(`reserves no top overlay or empty banner space for ${name}, scroll ${top}`, () => {
        scrolled = top;
        const { scrollport } = draw(window);
        fireEvent.scroll(scrollport, { target: { scrollTop: top } });
        // The former overlay was a sibling of the scrollport at its top edge. Even an empty
        // overlay must go: removing only its text still leaves that part of the thread covered.
        const topOverlays = [...scrollport.parentElement!.children].filter(
          (node) => node !== scrollport && node.classList.contains("absolute") && node.classList.contains("top-0"),
        );
        expect(topOverlays).toHaveLength(0);
        expect(scrollport.firstElementChild).toHaveTextContent("Load older");
      });
    }
  }

  it("loads exactly one older page only when the reader taps the history button", async () => {
    scrolled = 250;
    const { scrollport, feed } = draw(cases[1]!.window);
    expect(feed.loadOlder).not.toHaveBeenCalled();
    const button = within(scrollport).getByRole("button", { name: "Load older" });
    expect(screen.getAllByRole("button", { name: "Load older" })).toHaveLength(1);
    await userEvent.setup().click(button);
    expect(feed.loadOlder).toHaveBeenCalledTimes(1);
    for (const top of [0, 400, 0]) fireEvent.scroll(scrollport, { target: { scrollTop: top } });
    expect(feed.loadOlder).toHaveBeenCalledTimes(1);
  });

  it("does not seek or fetch an old reported prompt on mount, scroll, or a newer feed", () => {
    scrolled = 250;
    const feed = feedOf({ status: { kind: "live" }, ...cases[1]!.window });
    const listRef = createRef<ChatMessageListHandle>();
    const view = (current: ChatFeed) => (
      <SessionStream feed={current} address="w1:p1" working={false} showToolCalls showCompactions={false} fontSize={14} listRef={listRef} />
    );
    const { rerender } = render(view(feed));
    const scrollport = listRef.current!.getScrollElement()!;
    for (const top of [0, 250, 450, 0]) {
      scrolled = top;
      fireEvent.wheel(scrollport);
      fireEvent.scroll(scrollport, { target: { scrollTop: top } });
    }
    rerender(view({ ...feed, window: { ...feed.window, entries: [...replies, entry("d", BASE + 13, "new reply")] } }));
    expect(screen.getByText("new reply")).toBeInTheDocument();
    expect(feed.loadOlder).not.toHaveBeenCalled();
  });
});

// THE WAY IN TO A BLOCK'S ACTIONS (M90 spec 02): a `⋯` button, and the hold and the right click as second ways.
// What is pinned down: it is a real button that opens, a tap on the text does not, and a block that is growing,
// that cannot be pinned, or that sits where Pin may not be offered gets no way in at all.
describe("SessionStream pins", () => {
  afterEach(() => vi.useRealTimers());

  const feed = (entries: ChatEntry[]) => feedOf({ status: { kind: "live" }, entries });
  const two = feed([entry("u", BASE, "do it", { role: "user" }), entry("a", BASE + 1, "done")]);

  function renderPins(over: { feed?: ChatFeed; pins?: React.ComponentProps<typeof SessionStream>["pins"]; working?: boolean }) {
    const listRef = createRef<ChatMessageListHandle>();
    return render(
      <SessionStream
        feed={over.feed ?? two}
        address="w1:p1"
        working={over.working ?? false}
        showToolCalls
        showCompactions={false}
        fontSize={14}
        listRef={listRef}
        agent="muse"
        pins={over.pins}
      />,
    );
  }

  const opened = (): [ReturnType<typeof vi.fn<(item: ChatItem) => void>>, { pinned: ReadonlyMap<string, string>; onActions: (item: ChatItem) => void }] => {
    const onActions = vi.fn<(item: ChatItem) => void>();
    return [onActions, { pinned: new Map(), onActions }];
  };

  it("opens the actions from the ⋯ of a block, with that block's item", async () => {
    const [onActions, pins] = opened();
    renderPins({ pins });
    const buttons = screen.getAllByRole("button", { name: "Message actions" });
    expect(buttons).toHaveLength(2);
    await userEvent.click(buttons[1]!);
    expect(onActions).toHaveBeenCalledOnce();
    expect(onActions.mock.calls[0]![0]).toMatchObject({ id: "a:0", kind: "reply", text: "done" });
  });

  it("opens the block's sheet on a hold, after the hold's own delay and not before", () => {
    vi.useFakeTimers();
    const [onActions, pins] = opened();
    const { container } = renderPins({ pins });
    const block = container.querySelectorAll<HTMLElement>("[data-block]")[1]!;
    fireEvent.pointerDown(block, { button: 0, clientX: 10, clientY: 10, pointerType: "touch" });
    act(() => vi.advanceTimersByTime(BLOCK_HOLD_MS - 1));
    expect(onActions).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onActions).toHaveBeenCalledOnce();
    expect(onActions.mock.calls[0]![0]).toMatchObject({ id: "a:0" });
  });

  it("opens on a right click when no text is selected, and takes the native menu away", () => {
    const [onActions, pins] = opened();
    const { container } = renderPins({ pins });
    const block = container.querySelectorAll<HTMLElement>("[data-block]")[0]!;
    const menu = createEvent.contextMenu(block);
    fireEvent(block, menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(onActions).toHaveBeenCalledOnce();
  });

  it("leaves the native menu to the browser when text of the block is selected", () => {
    const [onActions, pins] = opened();
    const { container } = renderPins({ pins });
    const block = container.querySelectorAll<HTMLElement>("[data-block]")[1]!;
    const text = within(block).getByText("done");
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    const menu = createEvent.contextMenu(block);
    fireEvent(block, menu);
    window.getSelection()?.removeAllRanges();
    expect(menu.defaultPrevented).toBe(false);
    expect(onActions).not.toHaveBeenCalled();
  });

  it("does not open on a tap on the text, and a hold cut short opens nothing", () => {
    vi.useFakeTimers();
    const [onActions, pins] = opened();
    const { container } = renderPins({ pins });
    const block = container.querySelectorAll<HTMLElement>("[data-block]")[1]!;
    fireEvent.pointerDown(block, { button: 0, clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(100));
    fireEvent.pointerUp(block);
    fireEvent.click(within(block).getByText("done"));
    act(() => vi.advanceTimersByTime(BLOCK_HOLD_MS));
    expect(onActions).not.toHaveBeenCalled();
  });

  it("does not turn a hold into a pin when the finger moves off: a scroll is not a hold", () => {
    vi.useFakeTimers();
    const [onActions, pins] = opened();
    const { container } = renderPins({ pins });
    const block = container.querySelectorAll<HTMLElement>("[data-block]")[1]!;
    fireEvent.pointerDown(block, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(block, { clientX: 10, clientY: 80 });
    act(() => vi.advanceTimersByTime(BLOCK_HOLD_MS));
    expect(onActions).not.toHaveBeenCalled();
  });

  it("marks a pinned block with the pin glyph, named, and no other block", () => {
    const { container } = renderPins({ pins: { pinned: new Map([["a:0", "p1"]]), onActions: vi.fn() } });
    const blocks = container.querySelectorAll<HTMLElement>("[data-block]");
    expect(within(blocks[1]!).getByRole("img", { name: "Pinned" })).toBeInTheDocument();
    expect(within(blocks[0]!).queryByRole("img", { name: "Pinned" })).toBeNull();
  });

  it("still draws the mark where no way in is offered, and no ⋯", () => {
    renderPins({ pins: { pinned: new Map([["a:0", "p1"]]) } });
    expect(screen.getByRole("img", { name: "Pinned" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Message actions" })).toBeNull();
  });

  it("offers nothing without a pins prop: the stream is exactly what it was", () => {
    const { container } = renderPins({});
    expect(screen.queryByRole("button", { name: "Message actions" })).toBeNull();
    expect(container.querySelector("[data-slot='pin-mark']")).toBeNull();
  });

  it("does not offer a reply that is still being written, and offers it once it settles", () => {
    const writing = feed([entry("a", BASE, "typing", { partial: true })]);
    const [, pins] = opened();
    const view = renderPins({ feed: writing, pins, working: true });
    expect(screen.queryByRole("button", { name: "Message actions" })).toBeNull();
    view.unmount();
    renderPins({ feed: writing, pins, working: false });
    expect(screen.getAllByRole("button", { name: "Message actions" })).toHaveLength(1);
  });

  it("does not offer the compaction marker, and does offer a tool card", () => {
    const withImage = feed([
      entry("c", BASE, "the recap", { role: "summary" }),
      entry("t", BASE + 1, "", { parts: [{ kind: "tool", name: "Bash", summary: "ls", id: "toolu_1", result: { text: "a b" } }] }),
    ]);
    const [, pins] = opened();
    renderPins({ feed: withImage, pins });
    expect(screen.getAllByRole("button", { name: "Message actions" })).toHaveLength(1);
  });

  it("does not offer a tool call that is still running, and does once it has a result", () => {
    const running = feed([entry("t", BASE, "", { parts: [{ kind: "tool", name: "Bash", summary: "ls", id: "toolu_1" }] })]);
    const [, pins] = opened();
    const view = renderPins({ feed: running, pins });
    expect(screen.queryByRole("button", { name: "Message actions" })).toBeNull();
    view.unmount();
    const done = feed([entry("t", BASE, "", { parts: [{ kind: "tool", name: "Bash", summary: "ls", id: "toolu_1", result: { text: "a" } }] })]);
    renderPins({ feed: done, pins });
    expect(screen.getAllByRole("button", { name: "Message actions" })).toHaveLength(1);
  });

  it("does not offer the last reply while the agent works, though no item says `partial`, and offers it once it is idle", () => {
    const [, pins] = opened();
    const view = renderPins({ pins, working: true });
    // The person's line is offered, the reply being written is not.
    expect(screen.getAllByRole("button", { name: "Message actions" })).toHaveLength(1);
    expect(screen.getByText("do it").closest("[data-block]")!.querySelector("[data-slot='block-more']")).not.toBeNull();
    view.unmount();
    renderPins({ pins, working: false });
    expect(screen.getAllByRole("button", { name: "Message actions" })).toHaveLength(2);
  });

  it("offers a reply that a later block has followed, though the agent still works", () => {
    const later = feed([
      entry("a", BASE, "first thought"),
      entry("t", BASE + 1, "", { parts: [{ kind: "tool", name: "Bash", summary: "ls", id: "toolu_1", result: { text: "a" } }] }),
    ]);
    const [, pins] = opened();
    renderPins({ feed: later, pins, working: true });
    expect(screen.getAllByRole("button", { name: "Message actions" })).toHaveLength(2);
  });

  it("gives a folded run of steps no way in: it has no one text to keep", () => {
    const steps = feed(
      ["1", "2", "3"].map((n, i) => entry(`t${n}`, BASE + i, "", { parts: [{ kind: "tool", name: "Bash", summary: `ls ${n}`, id: `toolu_${n}` }] })),
    );
    const [, pins] = opened();
    renderPins({ feed: steps, pins });
    expect(screen.queryByRole("button", { name: "Message actions" })).toBeNull();
  });

  it("draws the way in with no box of its own: the block's own classes are the ones it always had, plus `relative`", () => {
    const { container } = renderPins({ pins: opened()[1] });
    const block = container.querySelector("[data-block]")!;
    expect(block.className).toContain("-m-3 p-3");
    expect(block.className).toContain("relative");
    expect(screen.getAllByRole("button", { name: "Message actions" })[0]!.className).toContain("absolute");
  });
});
