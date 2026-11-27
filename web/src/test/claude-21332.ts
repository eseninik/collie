// Minimal rows from Claude Code 2.1.332 on 2026-11-27 at 157 columns. The queued frame is
// from try.txt and the plain Bash frame is from screen-1.txt. Session text is replaced.
const WIDTH = 157;
const RULE = "─".repeat(WIDTH);
const HUD = "  [Opus 5.5] ████░░░░░░ 36% | git:(main*) | Weekly 14%";
const HUD_RIGHT_EDGE = 155;
const MODE = "  ⏵⏵ bypass permissions on · 1 shell · esc to interrupt · ↓ to manage";
const SPINNER = "✽ Bloviating… (14m 50s · ↓ 10.9k tokens)";
const BASH = [
  "  Bash(printf '%s\\n'",
  "    sample)",
  "  ⎿ \u00a0Running… (1m 46s)",
  "     (ctrl+b to run in background)",
];
const TIP = "  ⎿ \u00a0Tip: Use a fresh session for a new topic";
const reset = "\x1b[0m";
const grey = (row: string): string => "\x1b[38;2;153;153;153m" + row + reset;
const bar = "\x1b[38;2;136;136;136m" + RULE + reset;

export const claudeFrames = ["queued message", "running Bash"] as const;
export type ClaudeFrame = (typeof claudeFrames)[number];

interface FrameOptions {
  readonly box?: string;
  readonly newlyQueued?: string;
  readonly bash?: boolean;
  readonly queue?: boolean;
  readonly hud?: boolean;
  readonly compact?: boolean | "next";
  readonly running?: boolean;
}

export function claude21332(frame: ClaudeFrame, options: FrameOptions = {}): string {
  const styled = frame === "queued message";
  const { box, newlyQueued, bash = true, queue = styled, hud = true, compact = true, running = true } = options;
  const dim = styled ? grey : (row: string) => row;
  const rule = styled ? bar : RULE;
  const queued = [newlyQueued, queue ? "Please check the example." : undefined].filter((word) => word !== undefined);
  const rows = bash ? [...BASH.map(dim), ""] : [];
  for (const text of queued) {
    const echo = "❯ " + text;
    rows.push(
      styled ? "\x1b[38;2;153;153;153m\x1b[48;2;55;55;55m" + echo.padEnd(WIDTH) + reset : echo,
      dim("  ⎿  Queued · ctrl+q to send now"),
      "",
    );
  }
  if (running) rows.push(styled ? "\x1b[38;2;215;119;87m" + SPINNER + reset : SPINNER, dim(TIP), "");
  const prompt = styled ? grey("❯\u00a0") : "❯";
  let input = prompt;
  if (box) input += (styled ? "" : " ") + box;
  else if (queued.length > 0) {
    const placeholder = "Press up to edit queued messages";
    input += styled ? "\x1b[2m" + placeholder + reset : " " + placeholder;
  }
  rows.push(rule, input, rule);
  if (hud) {
    const tail = compact === "next" ? "auto-compact next" : "1% until auto-compact";
    rows.push(dim(compact ? HUD.padEnd(HUD_RIGHT_EDGE - tail.length) + tail : HUD));
  }
  rows.push(dim(running ? MODE : "  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage"));
  return rows.join("\n");
}
