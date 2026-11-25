import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseCodexTranscript } from "../../codex.ts";
import { parseClaudeTranscript } from "../../claude.ts";

// Executed by Bun inside the Playwright stand command. The adapters have transitive bun: imports,
// so Node's Playwright loader reads their factual wire output, rather than importing them itself.
const folder = resolve(process.env.CODEX_CHAT_MATERIALIZED ?? "../../codex-reports/codex-chat/materialized");
await mkdir(folder, { recursive: true });
for (const harness of ["claude", "codex"] as const) {
  const source = readFileSync(new URL(`./${harness}-reference.jsonl`, import.meta.url), "utf8");
  const entries = harness === "codex" ? parseCodexTranscript(source) : parseClaudeTranscript(source);
  await writeFile(resolve(folder, `${harness}.json`), JSON.stringify(entries));
}
