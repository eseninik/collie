import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { TranscriptEntry } from "@/lib/types";

// Independently authored wire oracle for rendering. Reader integration is exercised separately by
// the Bun journal tests and the Playwright materializer. Node must not import the Bun adapters.
export const CHAT_COMPARISON_IMAGE = `data:image/png;base64,${readFileSync(join(import.meta.dirname, "..", "..", "public", "badge-96x96.png")).toString("base64")}`;
export const CHAT_COMPARISON_MARKDOWN = '## Проверка\n\n**Готово.** Файл `src/greeting.ts` обновлён.\n\n1. Прочитан исходный код.\n2. Проверено приветствие.\n\n- Формат сохранён.\n- Изменение можно проверить.\n\n```ts\nexport const greeting = "Hello";\n```';
export const CHAT_COMPARISON_OUTPUT = Array.from({ length: 80 }, (_, index) => `output line ${String(index + 1).padStart(3, "0")}`).join("\n");

export function chatComparisonEntries(harness: "claude" | "codex"): TranscriptEntry[] {
  const prefix = harness;
  const ts = "2026-11-14T10:00:00.000Z";
  return [
    { uuid: `${prefix}-user`, ts, role: "user", parts: [{ kind: "text", text: "Сделай приветствие и проверь результат." }, { kind: "image", url: CHAT_COMPARISON_IMAGE, mimeType: "image/png" }] },
    { uuid: `${prefix}-answer`, ts, role: "assistant", parts: [{ kind: "text", text: CHAT_COMPARISON_MARKDOWN }] },
    { uuid: `${prefix}-thinking`, ts, role: "assistant", parts: [{ kind: "thinking", text: "Проверю файл перед изменением." }] },
    { uuid: `${prefix}-shell`, ts, role: "assistant", parts: [{ kind: "tool", name: "shell", id: `${prefix}-shell`, summary: 'printf "Hello\\n"', call: { kind: "execute", command: 'printf "Hello\\n"', exitCode: 0 }, result: { text: CHAT_COMPARISON_OUTPUT } }] },
    { uuid: `${prefix}-edit`, ts, role: "assistant", parts: [{ kind: "tool", name: "edit", id: `${prefix}-edit`, summary: "src/greeting.ts", call: { kind: "edit", path: "src/greeting.ts", added: 1, removed: 1, diff: [{ header: "@@ -1 +1 @@", lines: ['-export const greeting = "Hi";', '+export const greeting = "Hello";'] }] }, result: { text: "File updated." } }] },
    { uuid: `${prefix}-error`, ts, role: "assistant", parts: [{ kind: "tool", name: "shell", id: `${prefix}-error`, summary: "false", call: { kind: "execute", command: "false", exitCode: 7 }, result: { text: "verification failed", isError: true } }] },
    { uuid: `${prefix}-image`, ts, role: "assistant", parts: [{ kind: "tool", name: "view_image", id: `${prefix}-image`, summary: "/repo/reference.png", call: { kind: "read", path: "/repo/reference.png" }, result: { text: "", imageUrl: CHAT_COMPARISON_IMAGE } }] },
  ];
}
