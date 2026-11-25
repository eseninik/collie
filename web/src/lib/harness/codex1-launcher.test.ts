import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const launcher = resolve(import.meta.dirname, "../../../../scripts/codex1");
const dirs: string[] = [];
const defaults = [
  "--no-alt-screen", "--model", "gpt-6.1-sol",
  "-c", "model_reasoning_effort=high",
  "-c", "service_tier=default",
  "-c", "features.fast_mode=false",
  "-c", "features.ultrafast_mode=false",
];

function fakeCodex(exitCode: number): string {
  const dir = mkdtempSync(join(tmpdir(), "collie-codex1-"));
  dirs.push(dir);
  writeFileSync(join(dir, "codex"), `#!/bin/sh\nprintf '%s\\0' "$@"\nexit ${String(exitCode)}\n`, { mode: 0o755 });
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("@oracle:requirement codex1 short executable launcher", () => {
  it("@req:LAUNCH_1 preserves exact launch defaults and all additional argv", () => {
    const dir = fakeCodex(0);
    accessSync(launcher, constants.X_OK);
    const extra = ["resume", "session with spaces", "", "--model", "override model", "$(printf shell-expanded)", "literal*glob", "a\nb"];
    const result = spawnSync(launcher, extra, {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}` },
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.split("\0").slice(0, -1)).toEqual([...defaults, ...extra]);
  });

  it("@req:LAUNCH_2 returns the codex exit status", () => {
    const dir = fakeCodex(23);
    accessSync(launcher, constants.X_OK);
    const result = spawnSync(launcher, [], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}` },
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(23);
  });
});
