import { defineConfig } from "@playwright/test";

import base from "./playwright.config";

const PORT = 4193;
const URL = `http://127.0.0.1:${PORT}`;

// The task's own preview, so its phone/tablet snapshots cannot reuse another branch's server.
export default defineConfig({
  ...base,
  testMatch: "**/codex-chat-parity.spec.ts",
  retries: 0,
  workers: 1,
  outputDir: process.env.CODEX_CHAT_EVIDENCE_DIR ?? "../../codex-reports/codex-chat/playwright-results",
  reporter: [["list"]],
  use: { ...base.use, baseURL: URL, serviceWorkers: "block" },
  projects: [
    ...(base.projects ?? []).filter((project) => ["app-phone", "app-tablet"].includes(project.name ?? "")),
    { name: "app-desktop", use: { browserName: "chromium", viewport: { width: 1440, height: 1000 } } },
  ],
  webServer: {
    command: `bun e2e/fixtures/materialize-codex-chat.ts && bunx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    env: { COLLIE_DEV_TARGET: "http://127.0.0.1:9" },
    url: URL,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
