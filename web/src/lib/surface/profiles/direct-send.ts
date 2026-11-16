// The owner chooses direct phone sends for these profile ids (2026-11-14).
// Keep this policy beside the profiles; callers resolve aliases to a profile first.
import type { ProfileMatch } from "../profile";
import { reservedLead, sendLines, type SendMode, type SendWhen } from "../send";

export function directSendProfile(id: string | null | undefined): boolean {
  return id === "claude" || id === "codex";
}

/** Codex can swallow its first submit key after a paste; a fresh box read permits one retry. */
export function retrySubmitProfile(id: string | null | undefined): boolean {
  return id === "codex";
}

/** Only a person's ordinary message takes the direct path; explicit steers keep their own path. */
export function directSend(match: Pick<ProfileMatch, "profile"> | null, request: { readonly fromPhone?: boolean; readonly mode: SendMode; readonly text: string; readonly when?: SendWhen }): boolean {
  return request.fromPhone === true && request.mode === "send" && request.when !== "steer" && directSendProfile(match?.profile.id) && reservedLead(sendLines(request.text)[0] ?? "", match?.profile.reservedLeads ?? []) === null;
}
