import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { openComparisonChat } from "./fixtures/codex-chat";

// Oracle: task 4 and both owner screenshots, 2026-11-14. The helper reads committed journal
// fixtures through the real public parsers. These are layout/phone-image checks, not pixel baselines.
test.use({ serviceWorkers: "block" });

for (const harness of ["claude", "codex"] as const) {
  test(`@oracle:requirement ${harness}: comparison screenshots before and after`, async ({ page }, testInfo) => {
    await openComparisonChat(page, harness);
    await expect(page.getByText("Изменение сохранено. Проверка завершилась с ошибкой; исправлю её.", { exact: true })).toBeVisible();
    const folder = process.env.CODEX_CHAT_SCREENSHOTS ?? "../../codex-reports/codex-chat/screenshots";
    await mkdir(folder, { recursive: true });
    const stem = `${testInfo.project.name}-${harness}`;
    const stream = page.locator('[data-slot="session-stream"]');
    await expect(stream).toBeVisible();
    await page.getByRole("heading", { name: "Проверка", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(folder, `${stem}-prose.png`) });
    await page.getByText("Изменение сохранено. Проверка завершилась с ошибкой; исправлю её.", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(folder, `${stem}-footer.png`) });
    const group = stream.getByRole("button", { expanded: false }).filter({ hasText: /steps|tools|Thinking/i }).first();
    if (await group.count()) {
      await group.click();
      await page.screenshot({ path: join(folder, `${stem}-work.png`) });
    }
  });

  test(`@oracle:requirement ${harness}: owner reference elements fit the real viewport`, async ({ page }) => {
    await openComparisonChat(page, harness);
    const stream = page.locator('[data-slot="session-stream"]');
    await expect(stream.getByRole("heading", { name: "Проверка", exact: true })).toBeAttached();
    await expect(stream.locator("ol li")).toHaveCount(2);
    await expect(stream.locator("ul li")).toHaveCount(2);
    await expect(stream.locator("code").filter({ hasText: "src/greeting.ts" })).toBeAttached();
    await expect(stream.getByText("You", { exact: true })).toBeAttached();
    await expect(page.getByText("Still working…", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox")).toBeInViewport();
    await expect(page.locator('[data-slot="model-tag"]')).toContainText("medium");
    for (const name of ["Submit", "Discard", "Add to it", "Replace", "Send now"]) {
      await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    }
    await expect(page.getByText("Draft in terminal", { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test(`@oracle:requirement ${harness}: journal image opens full screen and closes`, async ({ page }, testInfo) => {
    await openComparisonChat(page, harness);
    const stream = page.locator('[data-slot="session-stream"]');
    const inline = stream.locator('img[src^="data:image/png;base64,"]').first();
    await expect(inline).toBeAttached();
    await inline.scrollIntoViewIfNeeded();
    await expect(inline).toBeVisible();
    await inline.click();
    const viewer = page.getByRole("dialog");
    await expect(viewer).toBeVisible();
    const image = viewer.locator("img");
    await expect(image).toBeVisible();
    const folder = process.env.CODEX_CHAT_SCREENSHOTS ?? "../../codex-reports/codex-chat/screenshots";
    await mkdir(folder, { recursive: true });
    await page.screenshot({ path: join(folder, `${testInfo.project.name}-${harness}-image-fullscreen.png`) });
    const viewport = page.viewportSize();
    const box = await image.boundingBox();
    expect(viewport).not.toBeNull();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
  });
}
