import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadDraft } from "@/lib/drafts";
import { markLive, resetLiveness } from "@/lib/liveness";
import { clearStatus } from "@/lib/status";
import { server } from "@/test/setup";
import { Composer } from "./composer";

// Oracle: direct-send brief, points 6–7, owner's words 2026-11-14.
// Written by the separate test author before the implementation.
beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  resetLiveness();
  markLive("w1:p1");
});
afterEach(() => cleanup());

function renderComposer(agent: "claude" | "codex" | "pi", overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const props: ComponentProps<typeof Composer> = {
    paneId: "w1:p1", agent, isShell: false, gone: false, readOnly: false,
    surface: { revision: 1, turn: "idle", modal: "none", composer: "empty" },
    text: "pane output", terminalDraft: null, rawTerminalDraft: null,
    prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false },
    display: { open: false, onToggle: vi.fn() }, onSent: vi.fn(), ...overrides,
  };
  const router = createMemoryRouter([{ path: "/", element: <Composer {...props} /> }]);
  return render(<RouterProvider router={router} />);
}

interface Posted { id: string; text: string; mode: string; rowsHash?: string; capAck?: boolean }
function bridge(answers: object[]) {
  const sends: Posted[] = [];
  server.use(http.post(/\/api\/send$/, async ({ request }) => {
    // SAFETY: Composer is the only poster; its request has these public send fields.
    sends.push(await request.json() as Posted);
    return HttpResponse.json(answers.shift() ?? { receipt: { outcome: "sent", keys: [] }, offers: [] });
  }));
  return sends;
}
function reply(outcome: string, reason?: string, offers: string[] = []) {
  return { receipt: { outcome, reason, keys: [] }, offers, rowsHash: "abc123" };
}
function noRecoveryUi() {
  expect(screen.queryByRole("button", { name: "Add to it" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
  expect(screen.queryByText(/Your text is in the box, but Enter was not pressed/u)).toBeNull();
}

describe("@req:DS_UI @oracle:requirement direct-send composer", () => {
  for (const agent of ["claude", "codex"] as const) {
    it(`${agent}: never displays a terminal draft preview`, () => {
      renderComposer(agent, { terminalDraft: "Collie leftover", rawTerminalDraft: "Collie leftover", surface: { revision: 1, turn: "idle", modal: "none", composer: "draft" } });
      expect(screen.queryByText(/Draft in terminal/iu)).toBeNull();
      expect(document.querySelector('[data-slot="terminal-draft-notice"]')).toBeNull();
    });

    it(`${agent}: Enter follows Replace then Submit automatically and clears the phone draft`, async () => {
      const user = userEvent.setup();
      const sends = bridge([
        reply("refused", "draft_present", ["append", "replace", "cancel"]),
        reply("typed_not_submitted", "mismatch", ["submit", "discard", "keys"]),
        reply("sent"),
      ]);
      renderComposer(agent);
      const field = screen.getByRole("textbox");
      await user.type(field, "new phone words");
      fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
      await waitFor(() => expect(sends.map((send) => send.mode)).toEqual(["send", "replace", "submit"]));
      expect(new Set(sends.map((send) => send.id)).size).toBe(3);
      expect(sends.map((send) => send.text)).toEqual(["new phone words", "new phone words", "new phone words"]);
      noRecoveryUi();
      await waitFor(() => expect(field).toHaveValue(""));
      expect(loadDraft(undefined, "w1:p1") ?? "").toBe("");
    });

    it(`${agent}: never loops on a repeated Replace offer`, async () => {
      const user = userEvent.setup();
      const sends = bridge([
        reply("refused", "draft_present", ["replace", "cancel"]),
        reply("refused", "draft_present", ["replace", "cancel"]),
        reply("sent"),
      ]);
      renderComposer(agent);
      await user.type(screen.getByRole("textbox"), "send only once again");
      await user.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(sends).toHaveLength(2));
      noRecoveryUi();
      expect(sends.map((send) => send.mode)).toEqual(["send", "replace"]);
    });

    it(`${agent}: never loops on a repeated Submit offer`, async () => {
      const user = userEvent.setup();
      const sends = bridge([
        reply("typed_not_submitted", "changed", ["submit", "discard", "keys"]),
        reply("typed_not_submitted", "changed", ["submit", "discard", "keys"]),
        reply("sent"),
      ]);
      renderComposer(agent);
      await user.type(screen.getByRole("textbox"), "submit only once again");
      await user.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(sends).toHaveLength(2));
      noRecoveryUi();
      expect(sends.map((send) => send.mode)).toEqual(["send", "submit"]);
    });

    it(`${agent}: a modal refusal is never followed by an automatic Submit`, async () => {
      const user = userEvent.setup();
      const sends = bridge([reply("typed_not_submitted", "modal_cue", ["submit", "discard", "keys"])]);
      renderComposer(agent);
      await user.type(screen.getByRole("textbox"), "modal must stop this");
      await user.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(sends).toHaveLength(1));
      noRecoveryUi();
      expect(screen.getByRole("textbox")).toHaveValue("modal must stop this");
    });

    it(`${agent}: a retry after a lost automatic Replace answer reuses that Replace id`, async () => {
      const user = userEvent.setup();
      const sends: Posted[] = [];
      server.use(http.post(/\/api\/send$/, async ({ request }) => {
        // SAFETY: Composer is the only poster; this captures its public send fields.
        sends.push(await request.json() as Posted);
        if (sends.length === 1) return HttpResponse.json(reply("refused", "draft_present", ["replace", "cancel"]));
        if (sends.length === 2) return new HttpResponse("answer lost after taking request", { status: 500 });
        return HttpResponse.json(reply("sent"));
      }));
      renderComposer(agent);
      await user.type(screen.getByRole("textbox"), "do this exactly once");
      await user.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(sends).toHaveLength(2));
      await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
      await user.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(sends).toHaveLength(3));
      expect(sends[1]?.mode).toBe("replace");
      expect(sends[2]).toMatchObject({ mode: "replace", id: sends[1]?.id, text: "do this exactly once" });
      await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
    });

    for (const screenKind of ["other screen", "no input box"] as const) {
      it(`${agent}: a legacy changed reply for ${screenKind} never auto-submits`, async () => {
        const user = userEvent.setup();
        const unsafe = screenKind === "other screen"
          ? { detail: "The agents screen owns the input box. Enter there starts a new session." }
          : { detail: "The input box could not be found.", surface: { revision: 1, turn: "unknown", modal: "unknown", composer: "unknown", reason: "no-match" } };
        const sends = bridge([{ ...reply("typed_not_submitted", "changed", ["submit", "discard", "keys"]), ...unsafe }]);
        renderComposer(agent);
        await user.type(screen.getByRole("textbox"), "this must stop safely");
        await user.click(screen.getByRole("button", { name: "Send" }));
        await waitFor(() => expect(sends).toHaveLength(1));
        noRecoveryUi();
        expect(screen.getByRole("textbox")).toHaveValue("this must stop safely");
      });
    }

    it(`${agent}: the cap still requires a person's confirmation`, async () => {
      const user = userEvent.setup();
      const sends = bridge([
        { ...reply("refused", "unconfirmed", ["commit", "keys"]), cap: { count: 5, limit: 5, harness: agent, version: "1.0.0" } },
        reply("sent"),
      ]);
      renderComposer(agent);
      await user.type(screen.getByRole("textbox"), "message requiring confirmation");
      await user.click(screen.getByRole("button", { name: "Send" }));
      const confirm = await screen.findByRole("button", { name: "Confirm and type" });
      expect(sends).toHaveLength(1);
      expect(screen.getByRole("textbox")).toHaveValue("message requiring confirmation");
      await user.click(confirm);
      await waitFor(() => expect(sends).toHaveLength(2));
      expect(sends[1]).toMatchObject({ mode: "send", rowsHash: "abc123", capAck: true });
      await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
    });

    it(`${agent}: Enter sends an attached image path and clears its chip`, async () => {
      const user = userEvent.setup();
      const sends = bridge([reply("sent")]);
      server.use(http.post(/\/api\/pane\/[^/]+\/upload$/, () => HttpResponse.json({ ok: true, path: "/tmp/direct-photo.png" })));
      renderComposer(agent);
      const field = screen.getByRole("textbox");
      await user.type(field, "look at this");
      fireEvent.change(screen.getByTestId("attach-photos"), { target: { files: [new File(["png"], "direct-photo.png", { type: "image/png" })] } });
      await waitFor(() => expect(screen.getByRole("button", { name: "Remove direct-photo.png" })).toBeInTheDocument());
      fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
      await waitFor(() => expect(sends).toHaveLength(1));
      expect(sends[0]?.text).toContain("/tmp/direct-photo.png");
      expect(sends[0]?.text).toContain("look at this");
      await waitFor(() => expect(field).toHaveValue(""));
      expect(screen.queryByRole("button", { name: "Remove direct-photo.png" })).toBeNull();
    });

    it(`${agent}: three failed sends never display the failure report card`, async () => {
      const user = userEvent.setup();
      const sends = bridge(Array.from({ length: 3 }, () => reply("unknown", "no_evidence", ["keys"])));
      renderComposer(agent);
      for (let index = 0; index < 3; index++) {
        await user.clear(screen.getByRole("textbox"));
        await user.type(screen.getByRole("textbox"), `attempt ${String(index)}`);
        await user.click(screen.getByRole("button", { name: "Send" }));
        await waitFor(() => expect(sends).toHaveLength(index + 1));
      }
      expect(screen.queryByText(/Sending failed \d+ times/u)).toBeNull();
      expect(document.querySelector('[data-slot="report-card"]')).toBeNull();
    });
  }

  it("pi keeps the terminal draft preview and its recovery controls", async () => {
    const user = userEvent.setup();
    const sends = bridge([reply("refused", "draft_present", ["append", "replace", "cancel"])]);
    renderComposer("pi", { terminalDraft: "pi draft", rawTerminalDraft: "pi draft", surface: { revision: 1, turn: "idle", modal: "none", composer: "draft" } });
    expect(await screen.findByText(/Draft in terminal/iu)).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "pi keeps its existing behaviour");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("button", { name: "Replace" })).toBeInTheDocument();
    expect(sends).toHaveLength(1);
  });
});
