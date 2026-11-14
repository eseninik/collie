import type { Page } from "@playwright/test";

// Measurements for a human report, never a pixel oracle. Missing surfaces stay null rather than
// inheriting a sibling's style or receiving an invented value.
export async function captureChatStyles(page: Page) {
  return page.evaluate(() => {
    const stream = document.querySelector('[data-slot="session-stream"]');
    const exactText = (text: string) => [...(stream?.querySelectorAll<HTMLElement>("*") ?? [])]
      .find((element) => element.childElementCount === 0 && element.textContent?.trim() === text) ?? null;
    const styleOf = (element: Element | null) => {
      if (element === null) return null;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName,
        text: element.textContent?.trim().slice(0, 220),
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        color: style.color, backgroundColor: style.backgroundColor,
        fontSize: style.fontSize, lineHeight: style.lineHeight, fontFamily: style.fontFamily,
        fontWeight: style.fontWeight, textAlign: style.textAlign,
        borderTopWidth: style.borderTopWidth, borderTopColor: style.borderTopColor,
        borderTopStyle: style.borderTopStyle, borderRadius: style.borderRadius,
        paddingTop: style.paddingTop, paddingRight: style.paddingRight,
        paddingBottom: style.paddingBottom, paddingLeft: style.paddingLeft,
        position: style.position,
      };
    };
    const borderedAncestor = (element: Element | null) => {
      for (let current = element; current !== null && current !== stream; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== "none") return current;
      }
      return null;
    };
    const user = exactText("Сделай приветствие и проверь результат.");
    const userAncestors = [];
    for (let current = user, depth = 0; current !== null && current !== stream && depth < 6; current = current.parentElement, depth += 1) userAncestors.push(styleOf(current));
    const prose = [...(stream?.querySelectorAll("p") ?? [])].find((element) => element.textContent?.includes("Файл")) ?? null;
    const code = [...(stream?.querySelectorAll("code") ?? [])].find((element) => element.textContent === "src/greeting.ts") ?? null;
    const composer = document.querySelector('textarea[placeholder="Type a reply…"], input[placeholder="Type a reply…"]');
    const live = exactText("Still working…");
    const model = document.querySelector('[data-slot="model-tag"]');
    return {
      viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio, scrollWidth: document.documentElement.scrollWidth },
      theme: { stored: localStorage.getItem("collie:theme:v1"), darkClass: document.documentElement.classList.contains("dark"), colorScheme: getComputedStyle(document.documentElement).colorScheme },
      body: styleOf(document.body), stream: styleOf(stream), prose: styleOf(prose), heading: styleOf(exactText("Проверка")),
      inlineCode: styleOf(code), fencedCode: styleOf(stream?.querySelector("pre") ?? null),
      user: { text: styleOf(user), card: styleOf(borderedAncestor(user)), ancestors: userAncestors },
      live: { text: styleOf(live), row: styleOf(live?.parentElement ?? null) },
      modelFooter: styleOf(model),
      composer: { field: styleOf(composer), frame: styleOf(borderedAncestor(composer)) },
    };
  });
}
