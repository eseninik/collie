/** Compare queue text across the bridge and Chat without changing the displayed message. */
export function foldQueueText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}
