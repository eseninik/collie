import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import type { AgentView, PaneChatResponse, SnapshotResponse } from "@/lib/types";
import {
  FIXTURE_CHAT_GEN,
  FIXTURE_SEQ_BASE,
  fixtureAgents,
  fixtureFileImage,
  fixtureSnapshot,
  fixtureTranscript,
  sendAnswer,
} from "@/test/handlers";
import { installApiStub, installPaneWorld, paneCapture, pinLocale } from "./fixtures/api";

// Owner's 2026-11-14 brief, A1/A2: the actual phone composer must remain usable over the new
// Codex screens. No bridge or live pane is contacted: the screen corpus and the journal fixtures
// are shared with the unit suite. The browser checks the phone's real field, Enter and image picker.
test.use({ serviceWorkers: "block" });
test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "app-phone", "the owner's phone viewport, Chromium 390 × 844");
  await pinLocale(page, "en");
  await installApiStub(page);
});

const CAPTURES = {
  codex: {
    idle: "codex--v0169-idle-tip--w80",
    working: "codex--v0169-working-queued--w80",
    queued: "codex--v0169-working-queued--w120",
    narrow: "codex--v0169-working-queued--w80",
    dialog: "codex--v0169-model-dialog--w120",
  },
  claude: {
    idle: "claude--v2301-idle-after-turn--w100",
    working: "claude--v2301-working-quiet--w100",
  },
} as const;

type Harness = keyof typeof CAPTURES;
type State = "idle" | "working";
interface PostedMessage { readonly id: string; readonly pane: string; readonly text: string; readonly mode: string }

const RUSSIAN = "Проверь мобильную версию приложения. Сообщение должно уйти целиком после нажатия Enter. "
  + "Сохрани каждый символ и порядок слов. Не оставляй черновик в терминале и не проси повторно подтвердить отправку. ";
const LONG_MESSAGE = RUSSIAN.repeat(4).trim();

async function openPane(page: Page, harness: Harness, screen: string, state: State = "idle") {
  const template = fixtureAgents.find((agent) => agent.agent === harness);
  if (template === undefined) throw new Error(`no fixture agent for ${harness}`);
  // The Surface is deliberately absent: the app must read the captured screen itself, rather than
  // inherit a made-up modal:none claim which would hide a broken profile.
  const agent: AgentView = { ...template, status: state, hasSession: true, sendProtocol: true, canSteer: true };
  const snapshot: SnapshotResponse = { ...fixtureSnapshot, agents: [agent], shellPanes: [] };
  const chat: PaneChatResponse = {
    paneId: agent.paneId,
    available: true,
    page: "live",
    gen: FIXTURE_CHAT_GEN,
    rev: 1,
    head: FIXTURE_SEQ_BASE + fixtureTranscript.length - 1,
    oldest: FIXTURE_SEQ_BASE,
    hasOlder: false,
    upserts: fixtureTranscript.map((entry, i) => Object.assign({}, entry, { seq: FIXTURE_SEQ_BASE + i })),
  };
  const world = await installPaneWorld(page, {
    paneId: agent.paneId,
    snapshot,
    chat,
    screens: { captured: paneCapture(screen) },
    start: "captured",
  });
  const posted: PostedMessage[] = [];
  await page.route((url) => url.pathname === "/api/send", (route) => {
    // SAFETY: /api/send is the app's own typed request; the stub only records it and uses the
    // same sendAnswer fixture as the unit suite.
    const body = route.request().postDataJSON() as PostedMessage;
    posted.push(body);
    return route.fulfill({ json: sendAnswer(body.id, "sent", undefined, { queued: state === "working" }) });
  });
  await page.route((url) => url.pathname === "/api/send/receipts", (route) => route.fulfill({ json: { receipts: [] } }));
  await page.goto(`/pane/${encodeURIComponent(agent.paneId)}`);
  await expect(page.getByRole("textbox")).toBeVisible();
  return { agent, posted, world };
}

async function noSendWarnings(page: Page) {
  for (const name of ["Submit", "Discard", "Add to it", "Replace"]) {
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
  for (const text of [
    en["unreadDialog.caption"],
    en["composer.draftPreview.title"],
    en["composer.protocol.typed"],
    en["composer.protocol.draft"],
    en["composer.protocol.notFree"],
    en["composer.protocol.unconfirmed"],
    en["composer.protocol.unknown"],
    en["composer.status.dialogWaiting"],
    "Sending failed",
  ]) await expect(page.getByText(text, { exact: false })).toHaveCount(0);
}

for (const state of ["idle", "working", "queued", "narrow"] as const) {
  test(`@oracle:requirement @req:A1 @req:A2-CONVERSATION Codex 0.169 ${state} shows the conversation on the phone`, async ({ page }) => {
    await openPane(page, "codex", CAPTURES.codex[state], state === "idle" ? "idle" : "working");
    await expect(page.getByText("what changed today?", { exact: true })).toBeVisible();
    await expect(page.getByText("One commit: abc1234.", { exact: true })).toBeVisible();
    await noSendWarnings(page);
    await expect(page.getByRole("textbox")).toBeInViewport();
  });
}

for (const harness of ["codex", "claude"] as const) {
  for (const state of ["idle", "working"] as const) {
    test(`@oracle:requirement @req:A2-SEND ${harness} ${state}: Enter sends 600+ Russian characters from the phone`, async ({ page }) => {
      expect(LONG_MESSAGE.length).toBeGreaterThanOrEqual(600);
      const { posted, agent } = await openPane(page, harness, CAPTURES[harness][state], state);
      const field = page.getByRole("textbox");
      await noSendWarnings(page);
      await field.fill(LONG_MESSAGE);
      await expect(field).toHaveValue(LONG_MESSAGE);
      await expect(field).toBeInViewport();
      await field.press("Enter");
      await expect.poll(() => posted.length).toBe(1);
      expect(posted[0]).toMatchObject({ pane: agent.paneId, text: LONG_MESSAGE });
      await expect(field).toHaveValue("");
      await noSendWarnings(page);
      await expect(field).toBeInViewport();
    });
  }

  test(`@oracle:requirement @req:A2-IMAGE ${harness}: the phone composer attaches an image and sends its path`, async ({ page }) => {
    const { agent, posted } = await openPane(page, harness, CAPTURES[harness].idle);
    const uploads: Buffer[] = [];
    const path = "/tmp/collie-phone.png";
    await page.route((url) => url.pathname === `/api/pane/${encodeURIComponent(agent.paneId)}/upload`, (route) => {
      const body = route.request().postDataBuffer();
      if (body !== null) uploads.push(body);
      return route.fulfill({ json: { ok: true, path } });
    });
    const png = fixtureFileImage("public/logo.png");
    if (png === null) throw new Error("the shared image fixture is absent");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: en["composer.attach.aria"], exact: true }).click();
    // The default capability offers Photos and Files. A photos-only host opens the picker directly.
    const photos = page.getByRole("button", { name: en["composer.attach.photos"], exact: true });
    if (await photos.isVisible()) await photos.click();
    await (await chooser).setFiles({ name: "collie-phone.png", mimeType: "image/png", buffer: Buffer.from(png) });
    const preview = page.getByRole("dialog", { name: en["composer.imageEdit.title"] });
    await expect(preview).toBeVisible();
    expect(uploads).toHaveLength(0);
    await preview.getByRole("button", { name: en["composer.imageEdit.attach"], exact: true }).click();
    await expect.poll(() => uploads.length).toBe(1);
    expect(uploads[0]?.includes(Buffer.from(png))).toBe(true);
    await expect(page.getByRole("button", { name: "Remove collie-phone.png", exact: true })).toBeVisible();
    await expect(preview).toHaveCount(0);
    await page.getByRole("textbox").press("Enter");
    await expect.poll(() => posted.length).toBe(1);
    expect(posted[0]?.text).toContain(path);
    await expect(page.getByRole("textbox")).toHaveValue("");
    await expect(page.getByRole("button", { name: "Remove collie-phone.png", exact: true })).toHaveCount(0);
  });
}

test("@oracle:requirement @req:A2-DIALOG a real Codex 0.169 dialog blocks Enter on the phone", async ({ page }) => {
  const { posted, world } = await openPane(page, "codex", CAPTURES.codex.dialog);
  const field = page.getByRole("textbox");
  const message = "Это сообщение должно остаться на телефоне до закрытия диалога.";
  await field.fill(message);
  await expect(page.getByRole("button", { name: en["composer.send.dialogFirst"], exact: true })).toBeVisible();
  await field.press("Enter");
  // A frame after the handler observes the key, so these assertions do not race its event delivery.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(posted).toHaveLength(0);
  expect(world.writes).toHaveLength(0);
  await expect(field).toHaveValue(message);
});
