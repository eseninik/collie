import { createRef } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SessionStream } from "./session-stream";
import { ItemView, ToolCard } from "./chat-cards";
import type { ChatMessageListHandle } from "./ui/chat/chat-message-list";
import { EMPTY_CHAT_WINDOW } from "@/lib/chat-window";
import { itemsOf, toolStatus } from "@/lib/chat-items";
import type { ChatFeed } from "@/hooks/use-chat-window";
import { CHAT_COMPARISON_IMAGE, chatComparisonEntries } from "@/test/codex-chat-fixtures";

// Oracle: owner task 4 and its two screenshots. These expected wire facts were written without
// reading the renderer or the new reader implementation. The real journal→page path is in E2E.
beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

function renderChat(harness: "codex" | "claude") {
  const feed: ChatFeed = {
    window: { ...EMPTY_CHAT_WINDOW, status: { kind: "live" }, entries: chatComparisonEntries(harness).map((entry, index) => ({ ...entry, seq: 1_000_000 + index })) },
    loadOlder: vi.fn(), loadingOlder: false, asked: 1, answered: 1, tried: true,
  };
  return render(<SessionStream feed={feed} address="w1:p1" working showToolCalls showCompactions={false} fontSize={16} listRef={createRef<ChatMessageListHandle>()} agent={harness} />);
}

for (const harness of ["claude", "codex"] as const) {
  describe(`@oracle:requirement ${harness} matches the owner's Chat reference`, () => {
    it("@req:CODEX_CHAT_PRESENTATION renders headings, lists, fenced code, and the reader's timestamp", () => {
      const { container } = renderChat(harness);
      expect(screen.getByRole("heading", { name: "Проверка", exact: true })).toBeInTheDocument();
      expect(container.querySelectorAll("ol > li")).toHaveLength(2);
      expect(container.querySelectorAll("ul > li")).toHaveLength(2);
      expect(container.querySelector("pre code")).toHaveTextContent('export const greeting = "Hello";');
      const user = screen.getByText("Сделай приветствие и проверь результат.").closest("[data-block]");
      expect(user).not.toBeNull();
      expect(within(user as HTMLElement).getByText("You", { exact: true })).toBeInTheDocument();
      expect(user!.querySelector("time")).toHaveAttribute("datetime", "2026-11-14T10:00:00.000Z");
    });

    it("@req:CODEX_CHAT_RUNNING shows the running turn without old send decisions", () => {
      renderChat(harness);
      expect(screen.getByText("Still working…", { exact: true })).toBeInTheDocument();
      for (const name of ["Submit", "Discard", "Add to it", "Replace", "Send now"]) expect(screen.queryByRole("button", { name, exact: true })).not.toBeInTheDocument();
      expect(screen.queryByText("Draft in terminal", { exact: true })).not.toBeInTheDocument();
    });

    it("@req:CODEX_CHAT_GROUPING groups consecutive thinking and tool steps behind one disclosure", () => {
      renderChat(harness);
      const calls = itemsOf(chatComparisonEntries(harness)[3]!);
      expect(calls[0]).toMatchObject({ kind: "tool", status: "done", tool: { kind: "execute" } });
      const folds = screen.getAllByRole("button", { expanded: false });
      expect(folds.length).toBeGreaterThan(0);
      expect(screen.queryByText("greeting.ts", { exact: true })).not.toBeInTheDocument();
      expect(screen.queryByText("Проверю файл перед изменением.")).not.toBeInTheDocument();
    });
  });
}

describe("@oracle:requirement mapped Codex tool details", () => {
  it("@req:CODEX_CHAT_OUTPUT keeps 80 lines folded and opens their actual output on demand", async () => {
    const part = chatComparisonEntries("codex")[3]!.parts[0]!;
    if (part.kind !== "tool" || part.call?.kind !== "execute") throw new Error("bad independent wire fixture");
    const item = itemsOf(chatComparisonEntries("codex")[3]!)[0]!;
    if (item.kind !== "tool") throw new Error("the shell must produce a tool item");
    const { container } = render(<ToolCard callId={item.id} tool={item.tool} status={item.status} />);
    expect(container.querySelector("pre")).toBeNull();
    await userEvent.click(screen.getByRole("button", { expanded: false }));
    expect(container.querySelector("pre")).toHaveTextContent("output line 001");
    expect(container.querySelector("pre")).toHaveTextContent("output line 080");
  });

  it("@req:CODEX_CHAT_DIFF shows the file, line counts, and actual removed/added text", () => {
    const item = itemsOf(chatComparisonEntries("codex")[4]!)[0]!;
    if (item.kind !== "tool") throw new Error("the patch must produce a tool item");
    render(<ToolCard callId={item.id} tool={item.tool} status={item.status} />);
    expect(screen.getByText("greeting.ts")).toBeInTheDocument();
    expect(screen.getByText("+1", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("−1", { exact: true })).toBeInTheDocument();
    expect(screen.getByText('export const greeting = "Hi";', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('export const greeting = "Hello";', { exact: false })).toBeInTheDocument();
  });

  it("@req:CODEX_CHAT_FAULT an explicit failed process never reads as a successful step", () => {
    const entry = chatComparisonEntries("codex")[5]!;
    const part = entry.parts[0]!;
    if (part.kind !== "tool") throw new Error("bad independent wire fixture");
    expect(toolStatus(part)).toBe("failed");
    const item = itemsOf(entry)[0]!;
    if (item.kind !== "tool") throw new Error("the process must produce a tool item");
    const { container } = render(<ToolCard callId={item.id} tool={item.tool} status={item.status} />);
    expect(container.querySelector("[data-active]")).toHaveTextContent(/failed|exit 7/i);
  });

  it("@req:CODEX_CHAT_INLINE_IMAGE keeps the actual returned image on the same read card", () => {
    const item = itemsOf(chatComparisonEntries("codex")[6]!)[0]!;
    expect(item).toMatchObject({ kind: "tool", image: CHAT_COMPARISON_IMAGE, tool: { kind: "read", path: "/repo/reference.png" } });
    const { container } = render(<ItemView item={item} />);
    expect(screen.getByText("reference.png", { exact: true })).toBeInTheDocument();
    expect(container.querySelector("img")).toHaveAttribute("src", CHAT_COMPARISON_IMAGE);
  });
});
