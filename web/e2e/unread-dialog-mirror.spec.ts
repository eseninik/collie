import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { fixtureSnapshot } from "@/test/handlers";

import { installApiStub, pinLocale } from "./fixtures/api";

// THE OWNER'S PHONE: Codex prints its update prompt on the top rows of a 40-row pane and leaves the
// rest blank. The unread-dialog card's mirror is capped and opens at its bottom (#667), so the blank
// tail left an empty black box and the operator had to scroll up to find the dialog. The rows of the
// mirror are pinned in src/components/unread-dialog-block.test.tsx; jsdom has no layout, so only a
// real engine can say the row is inside the box the operator looks at.

test.use({ serviceWorkers: "block" });

const PANE_ID = "w2:p1";
const LAST_ROW = "enter continue · esc skip";

const DIALOG = [
  "",
  "  Update available · 0.166.0 → 0.167.0",
  "  Release notes: https://github.com/openai/codex/releases/latest",
  "",
  "› 1. Update now (runs `sh -c 's=$(curl -fsSL https://chatgpt.com/codex/install.sh) && CODEX_NON_INTERACTIVE=1 eval",
  "     \"$s\"'`)",
  "  2. Skip",
  "  3. Skip until next version",
  "",
  `  ${LAST_ROW}`,
];
const PANE_ROWS = 40;
const SCREEN = [...DIALOG, ...Array<string>(PANE_ROWS - DIALOG.length).fill("")].join("\n");

const BLOCKED_SNAPSHOT = structuredClone(fixtureSnapshot);
for (const agent of BLOCKED_SNAPSHOT.agents) if (agent.paneId === PANE_ID) agent.status = "blocked";

async function openPane(page: Page, wrap: boolean) {
  await pinLocale(page, "en");
  await page.addInitScript((prefs) => window.localStorage.setItem("collie:display-prefs:v4", prefs), JSON.stringify({ wrap }));
  await installApiStub(page);
  await page.route((url) => url.pathname === "/api/snapshot", (route) => route.fulfill({ json: BLOCKED_SNAPSHOT }));
  await page.route(
    (url) => url.pathname === `/api/pane/${encodeURIComponent(PANE_ID)}`,
    (route) => route.fulfill({ json: { paneId: PANE_ID, text: SCREEN, truncated: false, revision: 1 } }),
  );
  await page.goto(`/pane/${encodeURIComponent(PANE_ID)}`);
}

/** The printed characters of the last dialog row and the box of the mirror that shows them, in viewport pixels. */
function measure(page: Page) {
  return page
    .getByRole("group", { name: en["unreadDialog.caption"] })
    .locator("pre")
    .evaluate((pre, last) => {
      const row = [...pre.children].find((child) => child.textContent!.includes(last));
      if (row === undefined) return { found: false };
      // The range starts after the row's leading newline, which sits at the end of the row above.
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      const printed: Text[] = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node instanceof Text && node.data.trim() !== "") printed.push(node);
      }
      const range = document.createRange();
      range.setStartBefore(printed[0]!);
      range.setEndAfter(printed.at(-1)!);
      const printedBox = range.getBoundingClientRect();
      const box = pre.getBoundingClientRect();
      return {
        found: true,
        inMirror: printedBox.top >= box.top && printedBox.bottom <= box.bottom,
        inViewport: box.top >= 0 && box.bottom <= window.innerHeight,
        rowTop: printedBox.top,
        rowBottom: printedBox.bottom,
        mirrorTop: box.top,
        mirrorBottom: box.bottom,
        scrollTop: pre.scrollTop,
        scrollHeight: pre.scrollHeight,
      };
    }, LAST_ROW);
}

for (const [setting, wrap] of [
  ["off", false],
  ["on", true],
] as const) {
  test(`@oracle:requirement @req:MIRROR-5 the dialog's last row opens inside the mirror with Wrap lines ${setting}`, async ({ page }) => {
    await openPane(page, wrap);

    const card = page.getByRole("group", { name: en["unreadDialog.caption"] });
    await expect(card.getByRole("button", { name: "Esc" })).toBeVisible();
    const mirror = card.locator("pre");
    await expect(mirror).toContainText(LAST_ROW);
    // The setting really reached this mirror: the two runs are not one layout measured twice.
    if (wrap) await expect(mirror).toHaveClass(/whitespace-pre-wrap/u);
    else await expect(mirror).not.toHaveClass(/whitespace-pre-wrap/u);
    await page.evaluate(() => document.fonts.ready);

    await expect
      .poll(() => measure(page))
      .toMatchObject({ found: true, inMirror: true, inViewport: true });
  });
}
